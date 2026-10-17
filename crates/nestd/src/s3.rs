//! The cell's object store on S3 (`docs/sandbox/state/object-store/`): content-addressed chunks and
//! manifests under `<prefix>chunks/<hex>` and `<prefix>manifests/<hex>`, written through a local
//! cache so a host re-reads nothing it wrote or already fetched.
//!
//! Requests are signed with SigV4 using the instance role's credentials from IMDSv2 (refreshed
//! before they expire). The store's methods are synchronous (callers run them on blocking
//! threads), so each request blocks on the runtime that created the store.

use std::io;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ring::{digest, hmac};
use serde::Deserialize;

use crate::storage::{LocalFsStore, ObjectStore};
use crate::util::{amz_date, parse_rfc3339_utc_ms};

/// Refresh role credentials this long before they expire.
const REFRESH_BEFORE_MS: i64 = 5 * 60_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Attempts per request (and per credentials fetch), with exponential backoff and jitter.
const ATTEMPTS: u32 = 6;
const BACKOFF_BASE_MS: u64 = 200;
const BACKOFF_MAX_MS: u64 = 5_000;

/// Tuning for [`S3Store`].
#[derive(Clone, Debug)]
pub struct S3Options {
    /// Concurrent chunk transfers per commit or restore.
    pub parallelism: usize,
    /// The local cache is trimmed to 80% of this once it grows past it (least recently used first).
    pub cache_max_bytes: u64,
    /// Objects larger than this go up as a multipart upload of `part_bytes` parts (S3 needs parts
    /// of at least 5 MiB, except the last, and at most 10,000 of them).
    pub multipart_threshold: usize,
    pub part_bytes: usize,
}

impl Default for S3Options {
    fn default() -> Self {
        Self { parallelism: 16, cache_max_bytes: 8 << 30, multipart_threshold: 8 << 20, part_bytes: 8 << 20 }
    }
}

/// Parts of one multipart upload in flight at once.
const PART_PARALLELISM: usize = 4;

/// A successful response: its body and `ETag` header.
struct Reply {
    body: Vec<u8>,
    etag: Option<String>,
}

/// What a failed attempt means for the next one.
enum Failure {
    /// Throttling, a server error or a transport problem: back off and try again.
    Retry(io::Error),
    /// The credentials were refused as expired: fetch fresh ones, then try again.
    Refresh(io::Error),
    Fatal(io::Error),
}

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
    options: S3Options,
    /// Bytes of cached chunks (an estimate between trims), and one trim at a time.
    cache_bytes: AtomicU64,
    trimming: Mutex<()>,
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
        options: S3Options,
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
            cache_bytes: AtomicU64::new(dir_bytes(&cache.root().join("chunks"))),
            cache,
            options,
            trimming: Mutex::new(()),
        })
    }

    /// Use this HTTP client (tests: an extra trusted root, e.g. a TLS-inspecting proxy's).
    pub fn with_http(mut self, http: reqwest::Client) -> Self {
        self.http = http;
        self
    }

    /// Account for a cached chunk; past the cap, delete the least recently used down to 80%.
    fn cached(&self, len: usize) {
        let total = self.cache_bytes.fetch_add(len as u64, Ordering::Relaxed) + len as u64;
        if total <= self.options.cache_max_bytes {
            return;
        }
        let Ok(_one) = self.trimming.try_lock() else { return };
        let dir = self.cache.root().join("chunks");
        let mut files: Vec<(SystemTime, u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.metadata().ok().filter(|m| m.is_file()).map(|m| (m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path())))
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        let mut used: u64 = files.iter().map(|f| f.1).sum();
        let target = self.options.cache_max_bytes / 10 * 8;
        for (_, len, path) in files {
            if used <= target {
                break;
            }
            if std::fs::remove_file(&path).is_ok() {
                used -= len;
            }
        }
        self.cache_bytes.store(used, Ordering::Relaxed);
    }

    /// A cache hit counts as a use (eviction is least recently used).
    fn touch(&self, hex: &str) {
        let path = self.cache.root().join("chunks").join(hex);
        if let Ok(f) = std::fs::File::options().append(true).open(path) {
            let _ = f.set_modified(SystemTime::now());
        }
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
            CredentialSource::Imds(url) => {
                let mut attempt = 0;
                loop {
                    match self.rt.block_on(imds_credentials(&self.http, url)) {
                        Ok(c) => break c,
                        Err(e) if attempt + 1 < ATTEMPTS => {
                            tracing::warn!("instance role credentials: {e:#}; retrying");
                            backoff(attempt);
                            attempt += 1;
                        }
                        Err(e) => return Err(io::Error::other(e)),
                    }
                }
            }
        };
        *self.creds.lock().unwrap() = Some(fresh.clone());
        Ok(fresh)
    }

    /// A signed request, retried with backoff on throttling, server errors and transport
    /// failures, and re-signed with fresh credentials if they were refused as expired. `Ok(None)`
    /// for 404. `query` is `(name, value)` pairs, unencoded.
    fn request(&self, method: reqwest::Method, key: &str, query: &[(&str, &str)], body: Option<&[u8]>) -> io::Result<Option<Reply>> {
        let mut attempt = 0;
        loop {
            let err = match self.attempt(&method, key, query, body) {
                Ok(r) => return Ok(r),
                Err(Failure::Fatal(e)) => return Err(e),
                Err(Failure::Refresh(e)) => {
                    *self.creds.lock().unwrap() = None;
                    e
                }
                Err(Failure::Retry(e)) => e,
            };
            attempt += 1;
            if attempt >= ATTEMPTS {
                return Err(err);
            }
            tracing::debug!(attempt, "S3 {method} {key}: {err}; retrying");
            backoff(attempt - 1);
        }
    }

    fn attempt(&self, method: &reqwest::Method, key: &str, query: &[(&str, &str)], body: Option<&[u8]>) -> Result<Option<Reply>, Failure> {
        // `credentials` already retried on its own.
        let creds = self.credentials().map_err(Failure::Fatal)?;
        let path = format!("{}{key}", self.prefix);
        let canonical_query = canonical_query(query);
        let url = if canonical_query.is_empty() { format!("{}/{path}", self.base) } else { format!("{}/{path}?{canonical_query}", self.base) };
        let canonical_uri = format!("{}/{path}", self.base).split_once(&self.host).map_or_else(|| format!("/{path}"), |(_, p)| p.to_string());
        let payload = hex::encode(digest::digest(&digest::SHA256, body.unwrap_or_default()));
        let date = amz_date(now_ms() / 1000);
        let mut headers =
            vec![("host".to_string(), self.host.clone()), ("x-amz-content-sha256".into(), payload.clone()), ("x-amz-date".into(), date.clone())];
        if let Some(t) = &creds.session_token {
            headers.push(("x-amz-security-token".into(), t.clone()));
        }
        let authorization = sign(&creds, &self.region, "s3", method.as_str(), &canonical_uri, &canonical_query, &headers, &payload, &date);
        let mut req = self.http.request(method.clone(), &url).header("authorization", authorization);
        for (k, v) in headers.iter().filter(|(k, _)| k != "host") {
            req = req.header(k, v);
        }
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }
        self.rt.block_on(async move {
            let res = req.send().await.map_err(|e| Failure::Retry(io::Error::other(e)))?;
            let status = res.status();
            if status == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            let etag = res.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
            let bytes = res.bytes().await.map_err(|e| Failure::Retry(io::Error::other(e)))?;
            if status.is_success() {
                return Ok(Some(Reply { body: bytes.to_vec(), etag }));
            }
            let text = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
            let err = io::Error::other(format!("S3 {method} {path}: {status} {text}"));
            Err(match status.as_u16() {
                408 | 429 | 500..=599 => Failure::Retry(err),
                400 | 403 if text.contains("ExpiredToken") || text.contains("InvalidToken") || text.contains("TokenRefreshRequired") => {
                    Failure::Refresh(err)
                }
                // HEAD responses have no body to say why; a 403 there may be an expired token too.
                403 if *method == reqwest::Method::HEAD => Failure::Refresh(err),
                _ => Failure::Fatal(err),
            })
        })
    }

    fn exists(&self, key: &str) -> io::Result<bool> {
        Ok(self.request(reqwest::Method::HEAD, key, &[], None)?.is_some())
    }

    fn get(&self, key: &str) -> io::Result<Vec<u8>> {
        self.request(reqwest::Method::GET, key, &[], None)?
            .map(|r| r.body)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("s3://{key} not found")))
    }

    fn put(&self, key: &str, data: &[u8]) -> io::Result<()> {
        if data.len() > self.options.multipart_threshold {
            return self.put_multipart(key, data);
        }
        self.request(reqwest::Method::PUT, key, &[], Some(data)).map(|_| ())
    }

    /// Create, upload parts (a few at a time, each retried on its own), complete. Any failure
    /// aborts the upload; the bucket's lifecycle rule also expires abandoned ones after a day.
    fn put_multipart(&self, key: &str, data: &[u8]) -> io::Result<()> {
        let part_bytes = self.options.part_bytes.max(5 << 20);
        let parts: Vec<&[u8]> = data.chunks(part_bytes).collect();
        if parts.len() > 10_000 {
            return Err(io::Error::other(format!("{key}: {} parts exceed S3's 10,000", parts.len())));
        }
        let created = self.request(reqwest::Method::POST, key, &[("uploads", "")], Some(&[]))?.ok_or_else(|| io::Error::other("create multipart upload: 404"))?;
        let upload = xml_value(&created.body, "UploadId").ok_or_else(|| io::Error::other("create multipart upload: no UploadId"))?;
        let result = self.upload_parts(key, &upload, &parts).and_then(|etags| self.complete_multipart(key, &upload, &etags));
        if result.is_err()
            && let Err(e) = self.request(reqwest::Method::DELETE, key, &[("uploadId", &upload)], None)
        {
            tracing::warn!("aborting multipart upload of {key}: {e}");
        }
        result
    }

    fn upload_parts(&self, key: &str, upload: &str, parts: &[&[u8]]) -> io::Result<Vec<String>> {
        let etags: Mutex<Vec<Option<String>>> = Mutex::new(vec![None; parts.len()]);
        let next = std::sync::atomic::AtomicUsize::new(0);
        let failed: Mutex<Option<io::Error>> = Mutex::new(None);
        std::thread::scope(|scope| {
            for _ in 0..PART_PARALLELISM.min(parts.len()) {
                scope.spawn(|| {
                    while failed.lock().unwrap().is_none() {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(part) = parts.get(i) else { return };
                        let n = (i + 1).to_string();
                        let r = self.request(reqwest::Method::PUT, key, &[("partNumber", &n), ("uploadId", upload)], Some(part)).and_then(|r| {
                            r.and_then(|r| r.etag).ok_or_else(|| io::Error::other(format!("{key} part {n}: no ETag")))
                        });
                        match r {
                            Ok(etag) => etags.lock().unwrap()[i] = Some(etag),
                            Err(e) => {
                                failed.lock().unwrap().get_or_insert(e);
                            }
                        }
                    }
                });
            }
        });
        if let Some(e) = failed.into_inner().unwrap() {
            return Err(e);
        }
        Ok(etags.into_inner().unwrap().into_iter().map(|e| e.expect("every part uploaded")).collect())
    }

    /// S3 can answer 200 with an error in the body here; that's retried like a 5xx.
    fn complete_multipart(&self, key: &str, upload: &str, etags: &[String]) -> io::Result<()> {
        let mut xml = String::from("<CompleteMultipartUpload>");
        for (i, etag) in etags.iter().enumerate() {
            xml.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>{}</ETag></Part>", i + 1, xml_escape(etag)));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let mut attempt = 0;
        loop {
            let r = self.request(reqwest::Method::POST, key, &[("uploadId", upload)], Some(xml.as_bytes()))?;
            let body = r.map(|r| r.body).unwrap_or_default();
            if String::from_utf8_lossy(&body).contains("<CompleteMultipartUploadResult") {
                return Ok(());
            }
            attempt += 1;
            let err = io::Error::other(format!("complete multipart upload of {key}: {}", String::from_utf8_lossy(&body[..body.len().min(300)])));
            if attempt >= ATTEMPTS {
                return Err(err);
            }
            backoff(attempt - 1);
        }
    }
}

impl ObjectStore for S3Store {
    fn parallelism(&self) -> usize {
        self.options.parallelism
    }
    fn has_chunk(&self, hex: &str) -> io::Result<bool> {
        // The cache only ever holds objects known to be in S3.
        Ok(self.cache.has_chunk(hex)? || self.exists(&format!("chunks/{hex}"))?)
    }
    fn put_chunk(&self, hex: &str, data: &[u8]) -> io::Result<()> {
        self.put(&format!("chunks/{hex}"), data)?;
        self.cache.put_chunk(hex, data)?;
        self.cached(data.len());
        Ok(())
    }
    fn get_chunk(&self, hex: &str) -> io::Result<Vec<u8>> {
        if let Ok(d) = self.cache.get_chunk(hex) {
            self.touch(hex);
            return Ok(d);
        }
        let d = self.get(&format!("chunks/{hex}"))?;
        // Unverified bytes never enter the cache: callers check content against its hash.
        if blake3::hash(&d).to_hex().as_str() == hex {
            self.cache.put_chunk(hex, &d)?;
            self.cached(d.len());
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

/// Sleep before retry `attempt` (0-based): 200 ms doubling to 5 s, with up to 50% jitter.
fn backoff(attempt: u32) {
    let base = BACKOFF_BASE_MS.saturating_mul(1 << attempt.min(10)).min(BACKOFF_MAX_MS);
    let mut b = [0u8; 2];
    rand::fill(&mut b[..]);
    let jitter = base / 2 * u64::from(u16::from_le_bytes(b)) / u64::from(u16::MAX);
    std::thread::sleep(Duration::from_millis(base / 2 + jitter));
}

fn dir_bytes(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok()?.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes()).as_ref().to_vec()
}

/// RFC 3986 percent-encoding as SigV4 wants it: unreserved characters stay, everything else
/// (including `/`) is `%XX`.
fn uri_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `name=value` pairs, encoded and sorted: both the request's query string and its canonical form.
fn canonical_query(query: &[(&str, &str)]) -> String {
    let mut q: Vec<(String, String)> = query.iter().map(|(k, v)| (uri_encode(k), uri_encode(v))).collect();
    q.sort();
    q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

/// The text of the first `<tag>…</tag>` in an XML body.
fn xml_value(body: &[u8], tag: &str) -> Option<String> {
    let text = String::from_utf8_lossy(body);
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = text[start..].find(&format!("</{tag}>"))? + start;
    Some(text[start..end].to_string())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The SigV4 `Authorization` header. `headers` are lowercase names with trimmed values, the
/// canonical URI is already encoded (nest's keys are hex and `/`), and `canonical_query` comes
/// from [`canonical_query`].
#[allow(clippy::too_many_arguments)]
fn sign(
    creds: &Credentials,
    region: &str,
    service: &str,
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(String, String)],
    payload_sha256: &str,
    amz_date: &str,
) -> String {
    let mut sorted: Vec<&(String, String)> = headers.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let canonical_headers: String = sorted.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = sorted.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request = format!("{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}");
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
        let auth = sign(&creds, "us-east-1", "s3", "GET", "/test.txt", "", &headers, empty, "20130524T000000Z");
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    /// A minimal S3: PUT stores, GET and HEAD read (404 when missing). It insists on a SigV4
    /// header and a payload hash that matches the body, counts requests per method, records the
    /// most requests ever in flight at once, and answers 503 to the next `fail_next` requests.
    /// Multipart uploads in progress: upload id → part number → bytes.
    type Uploads = Arc<Mutex<HashMap<String, HashMap<u32, Vec<u8>>>>>;

    #[derive(Clone, Default)]
    struct Fake {
        url: String,
        objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        calls: Arc<Mutex<HashMap<String, usize>>>,
        inflight: Arc<AtomicU64>,
        max_inflight: Arc<AtomicU64>,
        fail_next: Arc<AtomicU64>,
        uploads: Uploads,
        aborted: Arc<AtomicU64>,
        /// Answer 400 to this part number (a non-retryable failure).
        reject_part: Arc<AtomicU64>,
    }

    async fn fake_s3() -> Fake {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake = Fake { url: format!("http://{}", listener.local_addr().unwrap()), ..Default::default() };
        let f = fake.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                let f = f.clone();
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
                        let now = f.inflight.fetch_add(1, Ordering::SeqCst) + 1;
                        f.max_inflight.fetch_max(now, Ordering::SeqCst);
                        // Long enough that overlapping requests really overlap.
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        let mut parts = head.lines().next().unwrap().split(' ');
                        let (method, target) = (parts.next().unwrap().to_string(), parts.next().unwrap().to_string());
                        let (path, query) = target.split_once('?').map_or((target.clone(), String::new()), |(p, q)| (p.to_string(), q.to_string()));
                        let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(&format!("{name}="))).map(str::to_string);
                        *f.calls.lock().unwrap().entry(method.clone()).or_default() += 1;
                        let lower = head.to_ascii_lowercase();
                        assert!(lower.contains("authorization: aws4-hmac-sha256 credential=akid/"), "unsigned request");
                        let sha = hex::encode(digest::digest(&digest::SHA256, &body));
                        assert!(lower.contains(&format!("x-amz-content-sha256: {sha}")), "payload hash mismatch");
                        let throttled = f.fail_next.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
                        let mut etag = None;
                        let (status, out) = if throttled {
                            ("503 Slow Down", b"<Error><Code>SlowDown</Code></Error>".to_vec())
                        } else if method == "POST" && param("uploads").is_some() {
                            let id = format!("up{}", f.uploads.lock().unwrap().len() + 1);
                            f.uploads.lock().unwrap().insert(id.clone(), HashMap::new());
                            ("200 OK", format!("<InitiateMultipartUploadResult><UploadId>{id}</UploadId></InitiateMultipartUploadResult>").into_bytes())
                        } else if let (Some(n), Some(id)) = (param("partNumber"), param("uploadId")) {
                            let n: u32 = n.parse().unwrap();
                            if u64::from(n) == f.reject_part.load(Ordering::SeqCst) {
                                ("400 Bad Request", b"<Error><Code>InvalidPart</Code></Error>".to_vec())
                            } else {
                                etag = Some(format!("\"etag-{n}\""));
                                f.uploads.lock().unwrap().get_mut(&id).unwrap().insert(n, body);
                                ("200 OK", Vec::new())
                            }
                        } else if let Some(id) = param("uploadId") {
                            if method == "DELETE" {
                                f.uploads.lock().unwrap().remove(&id);
                                f.aborted.fetch_add(1, Ordering::SeqCst);
                                ("204 No Content", Vec::new())
                            } else {
                                // Complete: the listed parts, in order, with the ETags handed out.
                                let xml = String::from_utf8(body).unwrap();
                                let mut up = f.uploads.lock().unwrap().remove(&id).unwrap();
                                let mut whole = Vec::new();
                                for (i, part) in xml.split("<Part>").skip(1).enumerate() {
                                    assert!(part.contains(&format!("<PartNumber>{}</PartNumber>", i + 1)), "parts out of order");
                                    assert!(part.contains(&format!("<ETag>&quot;etag-{}&quot;</ETag>", i + 1)), "wrong ETag: {part}");
                                    whole.extend(up.remove(&(i as u32 + 1)).unwrap());
                                }
                                f.objects.lock().unwrap().insert(path, whole);
                                ("200 OK", b"<CompleteMultipartUploadResult></CompleteMultipartUploadResult>".to_vec())
                            }
                        } else {
                            match method.as_str() {
                                "PUT" => {
                                    f.objects.lock().unwrap().insert(path, body);
                                    ("200 OK", Vec::new())
                                }
                                _ => match f.objects.lock().unwrap().get(&path) {
                                    Some(d) => ("200 OK", if method == "HEAD" { Vec::new() } else { d.clone() }),
                                    None => ("404 Not Found", Vec::new()),
                                },
                            }
                        };
                        f.inflight.fetch_sub(1, Ordering::SeqCst);
                        let len = if method == "HEAD" { 0 } else { out.len() };
                        let etag = etag.map(|e| format!("ETag: {e}\r\n")).unwrap_or_default();
                        let resp = format!("HTTP/1.1 {status}\r\n{etag}Content-Length: {len}\r\n\r\n");
                        s.write_all(resp.as_bytes()).await.unwrap();
                        if method != "HEAD" {
                            s.write_all(&out).await.unwrap();
                        }
                    }
                });
            }
        });
        fake
    }

    fn store_with(endpoint: &str, cache: &std::path::Path, options: S3Options) -> S3Store {
        let creds = Credentials { access_key_id: "AKID".into(), secret_access_key: "secret".into(), session_token: Some("tok".into()), expires_ms: None };
        S3Store::new("cell", "us-east-1", "store/", Some(endpoint), CredentialSource::Static(creds), LocalFsStore::new(cache).unwrap(), options).unwrap()
    }

    fn store(endpoint: &str, cache: &std::path::Path) -> S3Store {
        store_with(endpoint, cache, S3Options::default())
    }

    /// An image with `n` distinct non-zero 4 MiB chunks (and holes between them).
    fn image(path: &std::path::Path, n: u64) {
        use std::io::{Seek, SeekFrom, Write};
        storage::create_sparse(path, 2 * n * u64::from(storage::DISK_CHUNK)).unwrap();
        let mut f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        for i in 0..n {
            f.seek(SeekFrom::Start(2 * i * u64::from(storage::DISK_CHUNK) + 17)).unwrap();
            f.write_all(format!("chunk {i} of a sandbox disk").as_bytes()).unwrap();
        }
    }

    /// Many chunks move concurrently, and the image still round-trips through another host.
    #[tokio::test(flavor = "multi_thread")]
    async fn transfers_chunks_in_parallel() {
        let fake = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let (img, out) = (dir.path().join("disk.img"), dir.path().join("restored.img"));
        image(&img, 24);
        let (a, b, url) = (dir.path().join("a"), dir.path().join("b"), fake.url.clone());
        let (img2, out2) = (img.clone(), out.clone());
        tokio::task::spawn_blocking(move || {
            let (_, h) = storage::commit_file(&store(&url, &a), &img2, ManifestKind::Disk).unwrap();
            storage::restore_file(&store(&url, &b), &h, &out2).unwrap();
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read(&img).unwrap(), std::fs::read(&out).unwrap());
        assert!(fake.max_inflight.load(Ordering::SeqCst) >= 4, "transfers ran {} at a time", fake.max_inflight.load(Ordering::SeqCst));
    }

    /// Throttling and server errors are retried; the commit succeeds once S3 recovers.
    #[tokio::test(flavor = "multi_thread")]
    async fn retries_throttling() {
        let fake = fake_s3().await;
        fake.fail_next.store(4, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("disk.img");
        image(&img, 2);
        let (a, url, img2) = (dir.path().join("a"), fake.url.clone(), img.clone());
        let opts = S3Options { parallelism: 1, ..S3Options::default() };
        tokio::task::spawn_blocking(move || storage::commit_file(&store_with(&url, &a, opts), &img2, ManifestKind::Disk).unwrap())
            .await
            .unwrap();
        assert_eq!(fake.fail_next.load(Ordering::SeqCst), 0);
        // 2 chunks + 1 manifest stored, despite 4 refused attempts.
        assert_eq!(fake.objects.lock().unwrap().len(), 3);
    }

    /// The cache stays under its cap, dropping the least recently used chunks first; a dropped
    /// chunk is simply fetched from S3 again.
    #[tokio::test(flavor = "multi_thread")]
    async fn caps_the_cache_least_recently_used_first() {
        let fake = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let (cache, url) = (dir.path().join("cache"), fake.url.clone());
        let cache2 = cache.clone();
        tokio::task::spawn_blocking(move || {
            let s = store_with(&url, &cache2, S3Options { parallelism: 1, cache_max_bytes: 1000, ..S3Options::default() });
            let chunk = |i: u32| vec![i as u8 + 1; 300];
            let hex = |i: u32| blake3::hash(&chunk(i)).to_hex().to_string();
            for i in 0..3 {
                s.put_chunk(&hex(i), &chunk(i)).unwrap();
                std::thread::sleep(Duration::from_millis(15));
            }
            // Use chunk 0 again, so chunk 1 is now the least recently used.
            s.get_chunk(&hex(0)).unwrap();
            std::thread::sleep(Duration::from_millis(15));
            s.put_chunk(&hex(3), &chunk(3)).unwrap(); // 1200 bytes > 1000: trim to <= 800
            let cached = |i: u32| cache2.join("chunks").join(hex(i)).exists();
            assert!(!cached(1), "the least recently used chunk goes first");
            assert!(cached(3), "the newest chunk stays");
            assert!(dir_bytes(&cache2.join("chunks")) <= 800);
            assert_eq!(s.get_chunk(&hex(1)).unwrap(), chunk(1), "an evicted chunk comes back from S3");
        })
        .await
        .unwrap();
    }

    /// A generation committed by one host restores on another that has never seen it: everything
    /// it needs comes from S3, and a second commit of the same image uploads nothing new.
    #[tokio::test(flavor = "multi_thread")]
    async fn commits_on_one_host_and_restores_on_another() {
        let fake = fake_s3().await;
        let (url, objects, calls) = (fake.url.clone(), fake.objects.clone(), fake.calls.clone());
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

    /// AWS's published SigV4 examples with a query string ("GET Bucket Lifecycle" and "Get Bucket
    /// (List Objects)").
    #[test]
    fn signs_query_strings_like_aws_documents() {
        let creds = Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
            expires_ms: None,
        };
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let headers = vec![
            ("host".to_string(), "examplebucket.s3.amazonaws.com".to_string()),
            ("x-amz-content-sha256".into(), empty.into()),
            ("x-amz-date".into(), "20130524T000000Z".into()),
        ];
        let sig = |q: &[(&str, &str)]| {
            let auth = sign(&creds, "us-east-1", "s3", "GET", "/", &canonical_query(q), &headers, empty, "20130524T000000Z");
            auth.rsplit("Signature=").next().unwrap().to_string()
        };
        assert_eq!(sig(&[("lifecycle", "")]), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
        assert_eq!(sig(&[("prefix", "J"), ("max-keys", "2")]), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    }

    /// Past the threshold an object goes up in parts (a few at a time), completes with the parts'
    /// ETags in order, and reads back whole.
    #[tokio::test(flavor = "multi_thread")]
    async fn uploads_large_objects_in_parts() {
        let fake = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let (url, cache) = (fake.url.clone(), dir.path().join("c"));
        let data: Vec<u8> = (0..(21u32 << 20)).map(|i| (i % 251) as u8).collect();
        let d2 = data.clone();
        let back = tokio::task::spawn_blocking(move || {
            let s = store(&url, &cache);
            s.put("manifests/big", &d2).unwrap();
            s.get("manifests/big").unwrap()
        })
        .await
        .unwrap();
        assert_eq!(back, data);
        // 21 MiB in 8 MiB parts: 3 part PUTs.
        assert_eq!(fake.calls.lock().unwrap().get("PUT"), Some(&3));
        assert!(fake.uploads.lock().unwrap().is_empty(), "the upload was completed");
    }

    /// A part that fails for good aborts the upload, and nothing is stored.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_part_aborts_the_upload() {
        let fake = fake_s3().await;
        fake.reject_part.store(2, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let (url, cache) = (fake.url.clone(), dir.path().join("c"));
        let err = tokio::task::spawn_blocking(move || store(&url, &cache).put("manifests/big", &vec![7u8; 20 << 20]).unwrap_err()).await.unwrap();
        assert!(err.to_string().contains("InvalidPart"), "{err}");
        assert_eq!(fake.aborted.load(Ordering::SeqCst), 1);
        assert!(fake.objects.lock().unwrap().is_empty());
    }

    /// Against real S3 (`cargo test -p nestd real_s3 -- --ignored`): needs `NEST_S3_TEST_BUCKET`,
    /// `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` if temporary), and
    /// optionally `NEST_S3_TEST_CA`, a PEM to trust as well (a TLS-inspecting proxy's).
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_s3_single_and_multipart() {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let bucket = std::env::var("NEST_S3_TEST_BUCKET").expect("NEST_S3_TEST_BUCKET");
        let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into());
        let creds = Credentials {
            access_key_id: std::env::var("AWS_ACCESS_KEY_ID").unwrap(),
            secret_access_key: std::env::var("AWS_SECRET_ACCESS_KEY").unwrap(),
            session_token: std::env::var("AWS_SESSION_TOKEN").ok(),
            expires_ms: None,
        };
        let mut http = reqwest::Client::builder().timeout(REQUEST_TIMEOUT);
        if let Ok(pem) = std::env::var("NEST_S3_TEST_CA") {
            for cert in reqwest::Certificate::from_pem_bundle(&std::fs::read(pem).unwrap()).unwrap() {
                http = http.add_root_certificate(cert);
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let prefix = format!("test/{}/", crate::util::random_hex(6));
        let s = S3Store::new(&bucket, &region, &prefix, None, CredentialSource::Static(creds), LocalFsStore::new(dir.path()).unwrap(), S3Options::default())
            .unwrap()
            .with_http(http.build().unwrap());
        let big: Vec<u8> = (0..(21u32 << 20)).map(|i| (i % 253) as u8).collect();
        tokio::task::spawn_blocking(move || {
            s.put("small", b"hello").unwrap();
            assert_eq!(s.get("small").unwrap(), b"hello");
            s.put("big", &big).unwrap();
            assert_eq!(s.get("big").unwrap(), big);
            assert!(s.exists("big").unwrap());
            assert!(!s.exists("absent").unwrap());
        })
        .await
        .unwrap();
        eprintln!("real S3 ok under s3://{bucket}/{prefix}");
    }
}
