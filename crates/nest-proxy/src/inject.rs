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

/// Inspect (and, when allowed, rewrite) request headers. The first blocking verdict wins.
pub fn apply(input: &Input<'_>, headers: &mut HeaderMap, uri: &Uri) -> Verdict {
    let mut substituted: Option<String> = None;
    for b in input.bindings {
        if b.placeholder.is_empty() || !present(&b.placeholder, headers, uri) {
            continue;
        }
        if !b.hosts.iter().any(|h| h.matches(input.host)) {
            return Verdict::WrongHost(b.name.clone());
        }
        if !input.tls {
            return Verdict::Plaintext(b.name.clone());
        }
        let secret = input.secrets.get(&b.name).filter(|s| s.expires_ms.is_none_or(|e| input.now_ms < e));
        let Some(secret) = secret.filter(|_| input.live) else {
            return Verdict::Expired(b.name.clone());
        };
        if substitute(b, &secret.value, headers) {
            substituted = Some(b.name.clone());
        }
    }
    substituted.map_or(Verdict::Clean, Verdict::Substituted)
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

fn substitute(b: &InjectionBinding, secret: &str, headers: &mut HeaderMap) -> bool {
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
                    headers.insert(AUTHORIZATION, sensitive(nv));
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
                        headers.insert(AUTHORIZATION, sensitive(nv));
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

    #[test]
    fn clean_requests_untouched() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer user-own-token".parse().unwrap());
        assert_eq!(run("github.com", true, true, &secrets(None), &mut h, "/"), Verdict::Clean);
        assert_eq!(h[AUTHORIZATION], "Bearer user-own-token");
    }
}
