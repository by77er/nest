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
    Ok(Enrolled {
        host: r.host,
        host_token: Secret(r.host_token),
        host_token_expires_ms: r.host_token_expires_ms,
        fleet_ws_url: r.fleet_ws_url,
        proxy_ca: Some((r.proxy_ca, key)),
    })
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
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(None));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let seen = seen2.clone();
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
                    } else if line.starts_with("POST /v1/hosts/enroll") {
                        *seen.lock().unwrap() = Some(serde_json::from_str(body).unwrap());
                        serde_json::json!({
                            "host": "hst_new", "host_token": "tok", "host_token_expires_ms": 123,
                            "fleet_ws_url": "wss://cp/v1/fleet",
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

    #[tokio::test]
    async fn enrolls_with_aws_identity_document_and_csr() {
        let (url, seen) = mock_server().await;
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "role": "burst", "cell": "aws-us-east-1", "control_url": url,
            "enrollment": {"type": "aws_imds", "imds_url": url},
            "driver": {"type": "process", "guest_command": ["x"]},
        }))
        .unwrap();
        assert!(matches!(cfg.driver, DriverConfig::Process { .. }));
        let e = enroll(&cfg).await.unwrap();
        assert_eq!(e.host.0, "hst_new");
        assert_eq!(e.fleet_ws_url, "wss://cp/v1/fleet");
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
