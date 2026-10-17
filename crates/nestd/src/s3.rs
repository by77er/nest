//! The cell's object store on S3 (`docs/sandbox/state/object-store/`): content-addressed chunks and
//! manifests under `<prefix>chunks/<hex>` and `<prefix>manifests/<hex>`, written through a local
//! cache so a host re-reads nothing it wrote or already fetched.
//!
//! Requests are signed with SigV4 using the instance role's credentials from IMDSv2 (refreshed
//! before they expire). The store's methods are synchronous (callers run them on blocking
//! threads), so each request blocks on the runtime that created the store.

use std::io;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ring::{digest, hmac};
use serde::Deserialize;

use crate::storage::{LocalFsStore, ObjectStore};
use crate::util::{amz_date, parse_rfc3339_utc_ms};

/// Refresh role credentials this long before they expire.
const REFRESH_BEFORE_MS: i64 = 5 * 60_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// Unix ms; `None` never expires (static credentials).
    pub expires_ms: Option<i64>,
}

pub enum CredentialSource {
    /// The instance role, through IMDSv2 at this base URL.
    Imds(String),
    /// Tests and hosts outside AWS.
    Static(Credentials),
}

pub struct S3Store {
    http: reqwest::Client,
    rt: tokio::runtime::Handle,
    region: String,
    /// `https://<bucket>.s3.<region>.amazonaws.com`, or `<endpoint>/<bucket>` (path style) when
    /// an endpoint is configured.
    base: String,
    host: String,
    prefix: String,
    source: CredentialSource,
    creds: Mutex<Option<Credentials>>,
    cache: LocalFsStore,
}

impl S3Store {
    /// Must be called inside a Tokio runtime; its handle runs every request.
    pub fn new(
        bucket: &str,
        region: &str,
        prefix: &str,
        endpoint: Option<&str>,
        source: CredentialSource,
        cache: LocalFsStore,
    ) -> anyhow::Result<Self> {
        let (base, host) = match endpoint {
            Some(e) => {
                let e = e.trim_end_matches('/');
                let host = e.split_once("://").map_or(e, |(_, h)| h).to_string();
                (format!("{e}/{bucket}"), host)
            }
            None => {
                let host = format!("{bucket}.s3.{region}.amazonaws.com");
                (format!("https://{host}"), host)
            }
        };
        Ok(Self {
            http: reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build()?,
            rt: tokio::runtime::Handle::current(),
            region: region.into(),
            base,
            host,
            prefix: prefix.into(),
            source,
            creds: Mutex::new(None),
            cache,
        })
    }

    fn credentials(&self) -> io::Result<Credentials> {
        let now = now_ms();
        if let Some(c) = self.creds.lock().unwrap().as_ref()
            && c.expires_ms.is_none_or(|e| e - now > REFRESH_BEFORE_MS)
        {
            return Ok(c.clone());
        }
        let fresh = match &self.source {
            CredentialSource::Static(c) => c.clone(),
            CredentialSource::Imds(url) => self.rt.block_on(imds_credentials(&self.http, url)).map_err(io::Error::other)?,
        };
        *self.creds.lock().unwrap() = Some(fresh.clone());
        Ok(fresh)
    }

    /// One signed request. `Ok(None)` for 404.
    fn request(&self, method: reqwest::Method, key: &str, body: Option<&[u8]>) -> io::Result<Option<Vec<u8>>> {
        let creds = self.credentials()?;
        let path = format!("{}{key}", self.prefix);
        let url = format!("{}/{path}", self.base);
        let canonical_uri = url.split_once(&self.host).map_or_else(|| format!("/{path}"), |(_, p)| p.to_string());
        let payload = hex::encode(digest::digest(&digest::SHA256, body.unwrap_or_default()));
        let date = amz_date(now_ms() / 1000);
        let mut headers =
            vec![("host".to_string(), self.host.clone()), ("x-amz-content-sha256".into(), payload.clone()), ("x-amz-date".into(), date.clone())];
        if let Some(t) = &creds.session_token {
            headers.push(("x-amz-security-token".into(), t.clone()));
        }
        let authorization = sign(&creds, &self.region, "s3", method.as_str(), &canonical_uri, &headers, &payload, &date);
        let mut req = self.http.request(method.clone(), &url).header("authorization", authorization);
        for (k, v) in headers.iter().filter(|(k, _)| k != "host") {
            req = req.header(k, v);
        }
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }
        self.rt.block_on(async move {
            let res = req.send().await.map_err(io::Error::other)?;
            let status = res.status();
            if status == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            let bytes = res.bytes().await.map_err(io::Error::other)?;
            if !status.is_success() {
                let text = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
                return Err(io::Error::other(format!("S3 {method} {path}: {status} {text}")));
            }
            Ok(Some(bytes.to_vec()))
        })
    }

    fn exists(&self, key: &str) -> io::Result<bool> {
        Ok(self.request(reqwest::Method::HEAD, key, None)?.is_some())
    }

    fn get(&self, key: &str) -> io::Result<Vec<u8>> {
        self.request(reqwest::Method::GET, key, None)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("s3://{key} not found")))
    }

    fn put(&self, key: &str, data: &[u8]) -> io::Result<()> {
        self.request(reqwest::Method::PUT, key, Some(data)).map(|_| ())
    }
}

impl ObjectStore for S3Store {
    fn has_chunk(&self, hex: &str) -> io::Result<bool> {
        // The cache only ever holds objects known to be in S3.
        Ok(self.cache.has_chunk(hex)? || self.exists(&format!("chunks/{hex}"))?)
    }
    fn put_chunk(&self, hex: &str, data: &[u8]) -> io::Result<()> {
        self.put(&format!("chunks/{hex}"), data)?;
        self.cache.put_chunk(hex, data)
    }
    fn get_chunk(&self, hex: &str) -> io::Result<Vec<u8>> {
        if let Ok(d) = self.cache.get_chunk(hex) {
            return Ok(d);
        }
        let d = self.get(&format!("chunks/{hex}"))?;
        // Unverified bytes never enter the cache: callers check content against its hash.
        if blake3::hash(&d).to_hex().as_str() == hex {
            self.cache.put_chunk(hex, &d)?;
        }
        Ok(d)
    }
    fn put_manifest(&self, hex: &str, data: &[u8]) -> io::Result<()> {
        // Content-addressed: a manifest already cached is already in S3.
        if self.cache.get_manifest(hex).is_ok() {
            return Ok(());
        }
        self.put(&format!("manifests/{hex}"), data)?;
        self.cache.put_manifest(hex, data)
    }
    fn get_manifest(&self, hex: &str) -> io::Result<Vec<u8>> {
        if let Ok(d) = self.cache.get_manifest(hex) {
            return Ok(d);
        }
        let d = self.get(&format!("manifests/{hex}"))?;
        if blake3::hash(&d).to_hex().as_str() == hex {
            self.cache.put_manifest(hex, &d)?;
        }
        Ok(d)
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes()).as_ref().to_vec()
}

/// The SigV4 `Authorization` header. `headers` are lowercase names with trimmed values, and the
/// canonical URI is already encoded (nest's keys are hex and `/`). No query string.
#[allow(clippy::too_many_arguments)]
fn sign(
    creds: &Credentials,
    region: &str,
    service: &str,
    method: &str,
    canonical_uri: &str,
    headers: &[(String, String)],
    payload_sha256: &str,
    amz_date: &str,
) -> String {
    let mut sorted: Vec<&(String, String)> = headers.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = sorted.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = sorted.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!("{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_sha256}");
    let day = &amz_date[..8];
    let scope = format!("{day}/{region}/{service}/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex::encode(digest::digest(&digest::SHA256, canonical_request.as_bytes())));
    let mut key = hmac_sha256(format!("AWS4{}", creds.secret_access_key).as_bytes(), day);
    for part in [region, service, "aws4_request"] {
        key = hmac_sha256(&key, part);
    }
    let signature = hex::encode(hmac_sha256(&key, &string_to_sign));
    format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", creds.access_key_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ImdsCredentials {
    access_key_id: String,
    secret_access_key: String,
    token: String,
    expiration: String,
}

/// The instance role's temporary credentials (IMDSv2).
async fn imds_credentials(http: &reqwest::Client, imds_url: &str) -> anyhow::Result<Credentials> {
    let token = http
        .put(format!("{imds_url}/latest/api/token"))
        .header("X-aws-ec2-metadata-token-ttl-seconds", "300")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let base = format!("{imds_url}/latest/meta-data/iam/security-credentials/");
    let get = |url: String| http.get(url).header("X-aws-ec2-metadata-token", token.clone()).send();
    let role = get(base.clone()).await?.error_for_status()?.text().await?;
    let role = role.lines().next().unwrap_or_default().trim().to_string();
    anyhow::ensure!(!role.is_empty(), "the instance has no IAM role");
    let c: ImdsCredentials = get(format!("{base}{role}")).await?.error_for_status()?.json().await?;
    Ok(Credentials {
        access_key_id: c.access_key_id,
        secret_access_key: c.secret_access_key,
        session_token: Some(c.token),
        expires_ms: parse_rfc3339_utc_ms(&c.expiration),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use nest_protocol::model::ManifestKind;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;
    use crate::storage;

    /// AWS's published SigV4 example for S3 ("GET Object", Signature Version 4 docs).
    #[test]
    fn signs_like_aws_documents() {
        let creds = Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
            expires_ms: None,
        };
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("range".into(), "bytes=0-9".into()),
            ("x-amz-content-sha256".into(), empty.into()),
            ("x-amz-date".into(), "20130524T000000Z".into()),
        ];
        let auth = sign(&creds, "us-east-1", "s3", "GET", "/test.txt", &headers, empty, "20130524T000000Z");
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    /// A minimal S3: PUT stores, GET and HEAD read (404 when missing). It insists on a SigV4
    /// header and a payload hash that matches the body, and counts requests per method.
    async fn fake_s3() -> (String, Arc<Mutex<HashMap<String, Vec<u8>>>>, Arc<Mutex<HashMap<String, usize>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let objects: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let calls: Arc<Mutex<HashMap<String, usize>>> = Arc::default();
        let (o, c) = (objects.clone(), calls.clone());
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let (o, c) = (o.clone(), c.clone());
                tokio::spawn(async move {
                    loop {
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 65536];
                        let (head, body) = loop {
                            let n = s.read(&mut tmp).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                let head = String::from_utf8_lossy(&buf[..i]).to_string();
                                let len = head
                                    .lines()
                                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                    .unwrap_or(0);
                                while buf.len() < i + 4 + len {
                                    let n = s.read(&mut tmp).await.unwrap();
                                    buf.extend_from_slice(&tmp[..n]);
                                }
                                break (head, buf[i + 4..i + 4 + len].to_vec());
                            }
                        };
                        let mut parts = head.lines().next().unwrap().split(' ');
                        let (method, path) = (parts.next().unwrap().to_string(), parts.next().unwrap().to_string());
                        *c.lock().unwrap().entry(method.clone()).or_default() += 1;
                        let lower = head.to_ascii_lowercase();
                        assert!(lower.contains("authorization: aws4-hmac-sha256 credential=akid/"), "unsigned request");
                        let sha = hex::encode(digest::digest(&digest::SHA256, &body));
                        assert!(lower.contains(&format!("x-amz-content-sha256: {sha}")), "payload hash mismatch");
                        let (status, out) = match method.as_str() {
                            "PUT" => {
                                o.lock().unwrap().insert(path, body);
                                ("200 OK", Vec::new())
                            }
                            _ => match o.lock().unwrap().get(&path) {
                                Some(d) => ("200 OK", if method == "HEAD" { Vec::new() } else { d.clone() }),
                                None => ("404 Not Found", Vec::new()),
                            },
                        };
                        let len = if method == "HEAD" { 0 } else { out.len() };
                        let resp = format!("HTTP/1.1 {status}\r\nContent-Length: {len}\r\n\r\n");
                        s.write_all(resp.as_bytes()).await.unwrap();
                        s.write_all(&out).await.unwrap();
                    }
                });
            }
        });
        (url, objects, calls)
    }

    fn store(endpoint: &str, cache: &std::path::Path) -> S3Store {
        let creds = Credentials { access_key_id: "AKID".into(), secret_access_key: "secret".into(), session_token: Some("tok".into()), expires_ms: None };
        S3Store::new("cell", "us-east-1", "store/", Some(endpoint), CredentialSource::Static(creds), LocalFsStore::new(cache).unwrap()).unwrap()
    }

    /// A generation committed by one host restores on another that has never seen it: everything
    /// it needs comes from S3, and a second commit of the same image uploads nothing new.
    #[tokio::test(flavor = "multi_thread")]
    async fn commits_on_one_host_and_restores_on_another() {
        let (url, objects, calls) = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("disk.img");
        storage::create_sparse(&img, 16 << 20).unwrap();
        {
            use std::io::{Seek, SeekFrom, Write};
            let mut f = std::fs::OpenOptions::new().write(true).open(&img).unwrap();
            f.seek(SeekFrom::Start(5 << 20)).unwrap();
            f.write_all(b"state that must survive the host").unwrap();
        }
        let (a, b) = (dir.path().join("cache-a"), dir.path().join("cache-b"));
        let (img2, out) = (img.clone(), dir.path().join("restored.img"));
        let (url2, out2) = (url.clone(), out.clone());
        let hash = tokio::task::spawn_blocking(move || {
            let host_a = store(&url2, &a);
            let (_, h) = storage::commit_file(&host_a, &img2, ManifestKind::Disk).unwrap();
            let (_, again) = storage::commit_file(&host_a, &img2, ManifestKind::Disk).unwrap();
            assert_eq!(h, again);
            let host_b = store(&url2, &b);
            storage::restore_file(&host_b, &h, &out2).unwrap();
            h
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read(&img).unwrap(), std::fs::read(&out).unwrap());
        let keys: Vec<String> = objects.lock().unwrap().keys().cloned().collect();
        assert!(keys.iter().all(|k| k.starts_with("/cell/store/chunks/") || k.starts_with("/cell/store/manifests/")), "{keys:?}");
        assert!(keys.iter().any(|k| k.ends_with(hash.0.strip_prefix("blake3:").unwrap())));
        // One data chunk and one manifest, each uploaded once: the re-commit hit the cache.
        assert_eq!(calls.lock().unwrap().get("PUT"), Some(&2));
    }
}
