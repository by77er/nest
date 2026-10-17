//! Host enrollment (`docs/interfaces/control-host/enrollment/`).
//!
//! Proves the host's identity (AWS IMDSv2 instance identity document, or a one-time token for
//! hosts outside AWS), sends a CSR for nest-proxy's per-host intermediate CA (the key stays
//! here), and receives the host token, fleet URL and signed intermediate.

use anyhow::{Context, bail};
use base64::Engine as _;
use nest_protocol::control::{CaCertificate, EnrollRequest, EnrollResponse, EnrollmentProof};
use nest_protocol::host::Secret;
use nest_protocol::model::{HostId, PROTOCOL_VERSION, TimestampMs};

use crate::config::{Config, EnrollmentConfig};

/// Result of enrollment: everything nestd needs to dial the fleet channel.
#[derive(Clone, Debug)]
pub struct Enrolled {
    pub host: HostId,
    pub host_token: Secret,
    pub host_token_expires_ms: TimestampMs,
    pub fleet_ws_url: String,
    /// Proxy intermediate CA and its private key (absent for static/dev credentials).
    pub proxy_ca: Option<(CaCertificate, Secret)>,
}

/// Generate the proxy CA key pair and a CSR for it. Returns `(key_pem, csr_pem)`.
pub fn proxy_ca_csr(cell: &str) -> anyhow::Result<(Secret, String)> {
    let key = rcgen::KeyPair::generate().context("generate proxy CA key")?;
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).context("csr params")?;
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
    params.distinguished_name.push(rcgen::DnType::CommonName, format!("nest-proxy intermediate ({cell})"));
    let csr = params.serialize_request(&key).context("serialize CSR")?;
    Ok((Secret(key.serialize_pem()), csr.pem().context("CSR PEM")?))
}

/// IMDSv2: session token, then the identity document and its RSA-2048 signature (`rsa2048`: the
/// CMS/PKCS#7 form the Worker verifies; the legacy `pkcs7` endpoint is DSA and not accepted).
/// `rsa2048` is already base64 (line-wrapped, possibly PEM-armored): it is sent as-is, joined,
/// never encoded again.
pub async fn aws_identity_proof(http: &reqwest::Client, imds_url: &str) -> anyhow::Result<EnrollmentProof> {
    let token = http
        .put(format!("{imds_url}/latest/api/token"))
        .header("X-aws-ec2-metadata-token-ttl-seconds", "300")
        .send()
        .await
        .context("IMDSv2 token")?
        .error_for_status()?
        .text()
        .await?;
    let get = |path: &str| {
        http.get(format!("{imds_url}/latest/dynamic/instance-identity/{path}")).header("X-aws-ec2-metadata-token", token.clone()).send()
    };
    let document = get("document").await?.error_for_status()?.text().await?;
    let pkcs7 = get("rsa2048").await?.error_for_status()?.text().await?;
    let pkcs7_b64: String =
        pkcs7.lines().filter(|l| !l.starts_with("-----")).flat_map(|l| l.chars().filter(|c| !c.is_whitespace())).collect();
    base64::engine::general_purpose::STANDARD.decode(&pkcs7_b64).context("IMDS rsa2048 signature is not base64")?;
    Ok(EnrollmentProof::AwsIdentityDocument { document_b64: base64::engine::general_purpose::STANDARD.encode(document), pkcs7_b64 })
}

/// The spot interruption deadline (Unix ms) once EC2 has scheduled one, from IMDSv2
/// `spot/instance-action` (404 until then). Rebalance recommendations are not notices.
pub async fn spot_deadline(http: &reqwest::Client, imds_url: &str) -> anyhow::Result<Option<i64>> {
    let token = http
        .put(format!("{imds_url}/latest/api/token"))
        .header("X-aws-ec2-metadata-token-ttl-seconds", "60")
        .send()
        .await
        .context("IMDSv2 token")?
        .error_for_status()?
        .text()
        .await?;
    let res = http.get(format!("{imds_url}/latest/meta-data/spot/instance-action")).header("X-aws-ec2-metadata-token", token).send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    #[derive(serde::Deserialize)]
    struct Action {
        time: String,
    }
    let a: Action = res.error_for_status()?.json().await.context("spot/instance-action")?;
    Ok(Some(crate::util::parse_rfc3339_utc_ms(&a.time).with_context(|| format!("bad spot action time {}", a.time))?))
}

pub async fn enroll(cfg: &Config) -> anyhow::Result<Enrolled> {
    let proof = match &cfg.enrollment {
        EnrollmentConfig::Static { host, host_token, fleet_ws_url } => {
            return Ok(Enrolled {
                host: host.clone(),
                host_token: Secret(host_token.clone()),
                host_token_expires_ms: i64::MAX,
                fleet_ws_url: fleet_ws_url.clone(),
                proxy_ca: None,
            });
        }
        _ if resumable(cfg).is_some() => {
            let e = resumable(cfg).expect("checked");
            tracing::info!(host = %e.host, "resuming with saved host credentials");
            return Ok(e);
        }
        EnrollmentConfig::TokenFile { path } => {
            let token = std::fs::read_to_string(path).with_context(|| format!("read enrollment token {}", path.display()))?;
            EnrollmentProof::EnrollmentToken { token: token.trim().to_string() }
        }
        EnrollmentConfig::AwsImds { imds_url } => aws_identity_proof(&http_client()?, imds_url).await?,
    };
    let (key, csr) = proxy_ca_csr(&cfg.cell)?;
    let req = EnrollRequest { protocol_version: PROTOCOL_VERSION, role: cfg.role, cell: cfg.cell.clone(), proof, proxy_ca_csr_pem: csr };
    let url = format!("{}/v1/hosts/enroll", cfg.control_url.trim_end_matches('/'));
    let resp = http_client()?.post(&url).json(&req).send().await.with_context(|| format!("POST {url}"))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("enrollment rejected: {status} {}", resp.text().await.unwrap_or_default());
    }
    let r: EnrollResponse = resp.json().await.context("enrollment response")?;
    // The fleet channel carries every command: never let an enrollment answer point it elsewhere.
    if url_host(&r.fleet_ws_url) != url_host(&cfg.control_url) {
        bail!("enrollment returned fleet_ws_url {} on a different host than {}", r.fleet_ws_url, cfg.control_url);
    }
    let e = Enrolled {
        host: r.host,
        host_token: Secret(r.host_token),
        host_token_expires_ms: r.host_token_expires_ms,
        fleet_ws_url: r.fleet_ws_url,
        proxy_ca: Some((r.proxy_ca, key)),
    };
    // Without these a restarted nestd couldn't rejoin: AWS instances enroll once.
    crate::credentials::save(&cfg.credentials_path(), &cfg.control_url, &cfg.cell, &e).context("save host credentials")?;
    Ok(e)
}

fn resumable(cfg: &Config) -> Option<Enrolled> {
    crate::credentials::load(&cfg.credentials_path(), &cfg.control_url, &cfg.cell, crate::util::now_ms())
}

/// The authority (host and port) of a URL, lowercased.
fn url_host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', '?', '#']).next().unwrap_or_default().to_ascii_lowercase()
}

fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DriverConfig;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Tiny HTTP server: IMDSv2 endpoints + `POST /v1/hosts/enroll` (records the body).
    async fn mock_server() -> (String, Arc<Mutex<Option<serde_json::Value>>>) {
        mock_server_with(None).await
    }

    /// `fleet_ws_url` defaults to this server's own address (as a real control plane answers).
    async fn mock_server_with(fleet_ws_url: Option<&str>) -> (String, Arc<Mutex<Option<serde_json::Value>>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let fleet = fleet_ws_url.map_or_else(|| format!("{}/v1/fleet", url.replace("http://", "ws://")), str::to_string);
        let seen = Arc::new(Mutex::new(None));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let seen = seen2.clone();
                let fleet = fleet.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 65536];
                    let mut n = 0;
                    loop {
                        n += s.read(&mut buf[n..]).await.unwrap();
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            if body.len() >= len { break; }
                        }
                    }
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (head, body) = text.split_once("\r\n\r\n").unwrap();
                    let line = head.lines().next().unwrap();
                    let reply = if line.starts_with("PUT /latest/api/token") {
                        "imds-token".to_string()
                    } else if line.contains("/instance-identity/document") {
                        assert!(head.to_ascii_lowercase().contains("x-aws-ec2-metadata-token: imds-token"));
                        "{\"instanceId\":\"i-0abc\"}".to_string()
                    } else if line.contains("/instance-identity/rsa2048") {
                        // As IMDS serves it: base64 of the DER SignedData, wrapped at 64 columns.
                        RSA2048_IMDS.to_string()
                    } else if line.contains("/meta-data/spot/instance-action") {
                        r#"{"action": "terminate", "time": "2026-10-17T04:20:00Z"}"#.to_string()
                    } else if line.starts_with("POST /v1/hosts/enroll") {
                        *seen.lock().unwrap() = Some(serde_json::from_str(body).unwrap());
                        serde_json::json!({
                            "host": "hst_new", "host_token": "tok", "host_token_expires_ms": 4_102_444_800_000i64,
                            "fleet_ws_url": fleet,
                            "proxy_ca": {"cert_pem": "CERT", "chain_pem": "CHAIN", "expires_ms": 456}
                        }).to_string()
                    } else {
                        String::new()
                    };
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
                    s.write_all(resp.as_bytes()).await.unwrap();
                });
            }
        });
        (url, seen)
    }

    /// The start of a real CMS SignedData (`30 80 06 09 2a 86 48 86 f7 0d 01 07 02 …`), as IMDS wraps it.
    const RSA2048_IMDS: &str = "MIAGCSqGSIb3DQEHAqCAMIACAQExDzANBglghkgBZQMEAgEFADCABgkqhkiG9w0B\nBwGggCSABIIB\n";

    fn aws_config(url: &str, state_dir: &std::path::Path) -> Config {
        serde_json::from_value(serde_json::json!({
            "role": "burst", "cell": "aws-us-east-1", "control_url": url,
            "enrollment": {"type": "aws_imds", "imds_url": url},
            "driver": {"type": "process", "guest_command": ["x"]},
            "state_dir": state_dir,
        }))
        .unwrap()
    }

    /// A restarted nestd rejoins with its saved credentials instead of enrolling again (an AWS
    /// instance may enroll only once).
    #[tokio::test]
    async fn a_restart_resumes_with_saved_credentials() {
        let (url, seen) = mock_server().await;
        let state = tempfile::tempdir().unwrap();
        let cfg = aws_config(&url, state.path());
        let first = enroll(&cfg).await.unwrap();
        assert!(seen.lock().unwrap().take().is_some(), "the first start enrolls");
        let again = enroll(&cfg).await.unwrap();
        assert!(seen.lock().unwrap().is_none(), "a restart must not enroll again");
        assert_eq!((again.host.0.as_str(), again.host_token.expose()), (first.host.0.as_str(), first.host_token.expose()));
        assert_eq!(again.proxy_ca.unwrap().1.expose(), first.proxy_ca.unwrap().1.expose());
    }

    /// An enrollment answer can't point the command channel at another host.
    #[tokio::test]
    async fn refuses_a_fleet_url_on_another_host() {
        let (url, _) = mock_server_with(Some("wss://elsewhere.example/v1/fleet")).await;
        let state = tempfile::tempdir().unwrap();
        let err = enroll(&aws_config(&url, state.path())).await.unwrap_err();
        assert!(err.to_string().contains("different host"), "{err:#}");
        assert!(!state.path().join("host-credentials.json").exists());
    }

    #[tokio::test]
    async fn reads_the_spot_interruption_deadline() {
        let (url, _) = mock_server().await;
        let deadline = spot_deadline(&http_client().unwrap(), &url).await.unwrap();
        assert_eq!(deadline, crate::util::parse_rfc3339_utc_ms("2026-10-17T04:20:00Z"));
    }

    #[tokio::test]
    async fn enrolls_with_aws_identity_document_and_csr() {
        let (url, seen) = mock_server().await;
        let state = tempfile::tempdir().unwrap();
        let cfg = aws_config(&url, state.path());
        assert!(matches!(cfg.driver, DriverConfig::Process { .. }));
        let e = enroll(&cfg).await.unwrap();
        assert_eq!(e.host.0, "hst_new");
        assert_eq!(e.fleet_ws_url, format!("{}/v1/fleet", url.replace("http://", "ws://")));
        let (ca, key) = e.proxy_ca.unwrap();
        assert_eq!(ca.cert_pem, "CERT");
        assert!(key.0.contains("PRIVATE KEY"));
        let body = seen.lock().unwrap().clone().unwrap();
        assert_eq!(body["proof"]["type"], "aws_identity_document");
        let doc = base64::engine::general_purpose::STANDARD.decode(body["proof"]["document_b64"].as_str().unwrap()).unwrap();
        assert_eq!(doc, b"{\"instanceId\":\"i-0abc\"}");
        // The rsa2048 signature (not the legacy DSA pkcs7) is sent once-encoded: it decodes to the
        // DER SignedData itself (the Worker parses exactly this), not to IMDS's base64 text.
        let sig = base64::engine::general_purpose::STANDARD.decode(body["proof"]["pkcs7_b64"].as_str().unwrap()).unwrap();
        assert_eq!(&sig[..4], &[0x30, 0x80, 0x06, 0x09]);
        assert_eq!(body["proof"]["pkcs7_b64"], RSA2048_IMDS.replace('\n', ""));
        assert!(body["proxy_ca_csr_pem"].as_str().unwrap().contains("BEGIN CERTIFICATE REQUEST"));
    }
}
