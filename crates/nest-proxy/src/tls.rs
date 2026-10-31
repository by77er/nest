//! TLS: on-the-fly leaf certificates signed by the per-host intermediate CA (from nestd's
//! `ca_install`), and upstream client configs that verify servers against public roots and fail
//! closed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

use nest_protocol::control::CaCertificate;

use crate::util::now_ms;

/// Lifetime of minted leaf certificates (capped by the intermediate's expiry).
const LEAF_LIFETIME_MS: i64 = 24 * 3600 * 1000;
/// Backdate leaves to tolerate guest clock skew (guests resync clocks on resume).
const LEAF_BACKDATE_MS: i64 = 3600 * 1000;
/// Upper bound on cached leaves.
const LEAF_CACHE_MAX: usize = 4096;

pub fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The per-host intermediate CA, held in memory only.
pub struct Ca {
    issuer: Issuer<'static, KeyPair>,
    /// Intermediate (+ root), served after each leaf.
    chain: Vec<CertificateDer<'static>>,
    expires_ms: i64,
    cache: Mutex<HashMap<String, (Arc<CertifiedKey>, i64)>>,
}

impl Ca {
    pub fn from_install(ca: &CaCertificate, key_pem: &str) -> Result<Ca> {
        let key = KeyPair::from_pem(key_pem).context("parse CA key")?;
        let issuer = Issuer::from_ca_cert_pem(&ca.cert_pem, key).context("parse CA certificate")?;
        let chain_src = if ca.chain_pem.trim().is_empty() { &ca.cert_pem } else { &ca.chain_pem };
        let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(chain_src.as_bytes())
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow!("parse CA chain: {e:?}"))?;
        if chain.is_empty() {
            return Err(anyhow!("empty CA chain"));
        }
        Ok(Ca { issuer, chain, expires_ms: ca.expires_ms, cache: Mutex::new(HashMap::new()) })
    }

    /// Leaf certificate + key for `host` (DNS name or IP literal), cached per host.
    pub fn leaf(&self, host: &str) -> Result<Arc<CertifiedKey>> {
        let now = now_ms();
        if now >= self.expires_ms {
            return Err(anyhow!("proxy CA expired"));
        }
        let host = host.to_ascii_lowercase();
        if let Some((ck, exp)) = self.cache.lock().unwrap().get(&host)
            && *exp > now + 60_000
        {
            return Ok(ck.clone());
        }
        let not_after = (now + LEAF_LIFETIME_MS).min(self.expires_ms);
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
        let mut params = CertificateParams::new(vec![host.clone()])?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, host.clone());
        params.distinguished_name = dn;
        params.is_ca = IsCa::NoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        params.not_before = ms_to_time(now - LEAF_BACKDATE_MS);
        params.not_after = ms_to_time(not_after);
        let cert = params.signed_by(&key, &self.issuer)?;
        let mut chain = vec![cert.der().clone()];
        chain.extend(self.chain.iter().cloned());
        let key_der = PrivateKeyDer::Pkcs8(key.serialize_der().into());
        let signing = provider().key_provider.load_private_key(key_der).map_err(|e| anyhow!("load leaf key: {e}"))?;
        let ck = Arc::new(CertifiedKey::new(chain, signing));
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= LEAF_CACHE_MAX {
            cache.retain(|_, (_, exp)| *exp > now + 60_000);
            if cache.len() >= LEAF_CACHE_MAX {
                cache.clear();
            }
        }
        cache.insert(host, (ck.clone(), not_after));
        Ok(ck)
    }

    /// Server config presenting the leaf for `host`, offering exactly `alpn`.
    pub fn server_config(&self, host: &str, alpn: Vec<Vec<u8>>) -> Result<Arc<ServerConfig>> {
        let ck = self.leaf(host)?;
        let mut cfg = ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(FixedCert(ck)));
        cfg.alpn_protocols = alpn;
        Ok(Arc::new(cfg))
    }
}

fn ms_to_time(ms: i64) -> time::OffsetDateTime {
    time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000)).unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
}

#[derive(Debug)]
struct FixedCert(Arc<CertifiedKey>);

impl ResolvesServerCert for FixedCert {
    fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

/// Upstream TLS client configs (one per ALPN offer), verifying against public roots.
pub struct UpstreamTls {
    roots: Arc<RootCertStore>,
    cache: Mutex<HashMap<Vec<Vec<u8>>, Arc<ClientConfig>>>,
}

impl UpstreamTls {
    pub fn new(webpki: bool, extra: &[CertificateDer<'static>]) -> Result<Self> {
        let mut roots = RootCertStore::empty();
        if webpki {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
        for c in extra {
            roots.add(c.clone()).map_err(|e| anyhow!("extra root: {e}"))?;
        }
        Ok(UpstreamTls { roots: Arc::new(roots), cache: Mutex::new(HashMap::new()) })
    }

    pub fn client_config(&self, alpn: &[Vec<u8>]) -> Result<Arc<ClientConfig>> {
        let key = alpn.to_vec();
        if let Some(c) = self.cache.lock().unwrap().get(&key) {
            return Ok(c.clone());
        }
        let mut cfg = ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(self.roots.clone())
            .with_no_client_auth();
        cfg.alpn_protocols = key.clone();
        let cfg = Arc::new(cfg);
        self.cache.lock().unwrap().insert(key, cfg.clone());
        Ok(cfg)
    }
}

/// ALPN protocols the proxy can speak on both sides.
pub fn supported_alpn(offered: &[Vec<u8>]) -> Vec<Vec<u8>> {
    offered.iter().filter(|p| p.as_slice() == b"h2" || p.as_slice() == b"http/1.1").cloned().collect()
}

#[cfg(test)]
pub(crate) mod testca {
    //! Test PKI: a root, an intermediate for the proxy (as nestd would install), and a separate
    //! "public" CA for upstream servers.
    use super::*;
    use rcgen::{BasicConstraints, CertifiedIssuer};

    pub struct TestPki {
        pub root_pem: String,
        pub install: CaCertificate,
        pub key_pem: String,
    }

    pub fn ca_params(cn: &str) -> CertificateParams {
        let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, cn);
        p.distinguished_name = dn;
        p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        p
    }

    pub fn proxy_pki() -> TestPki {
        let root_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let root = CertifiedIssuer::self_signed(ca_params("nest test root"), root_key).unwrap();
        let int_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let int_pem_key = int_key.serialize_pem();
        let int_cert = ca_params("nest test host intermediate").signed_by(&int_key, &root).unwrap();
        TestPki {
            root_pem: root.pem(),
            install: CaCertificate {
                cert_pem: int_cert.pem(),
                chain_pem: format!("{}{}", int_cert.pem(), root.pem()),
                expires_ms: now_ms() + 7 * 24 * 3600 * 1000,
            },
            key_pem: int_pem_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::WebPkiServerVerifier;
    use rustls::client::danger::ServerCertVerifier;
    use rustls_pki_types::{ServerName, UnixTime};

    #[test]
    fn minted_leaf_chains_to_root() {
        let pki = testca::proxy_pki();
        let ca = Ca::from_install(&pki.install, &pki.key_pem).unwrap();
        let ck = ca.leaf("api.github.com").unwrap();
        assert_eq!(ck.cert.len(), 3, "leaf + intermediate + root");
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from_pem_slice(pki.root_pem.as_bytes()).unwrap()).unwrap();
        let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider()).build().unwrap();
        let name = ServerName::try_from("api.github.com").unwrap();
        verifier.verify_server_cert(&ck.cert[0], &ck.cert[1..], &name, &[], UnixTime::now()).unwrap();
        let wrong = ServerName::try_from("evil.com").unwrap();
        assert!(verifier.verify_server_cert(&ck.cert[0], &ck.cert[1..], &wrong, &[], UnixTime::now()).is_err());
        // Cached.
        assert!(Arc::ptr_eq(&ck, &ca.leaf("API.github.com").unwrap()));
        // IP literal hosts get IP SANs.
        ca.leaf("10.1.2.3").unwrap();
    }

    #[test]
    fn expired_ca_refuses() {
        let mut pki = testca::proxy_pki();
        pki.install.expires_ms = now_ms() - 1;
        let ca = Ca::from_install(&pki.install, &pki.key_pem).unwrap();
        assert!(ca.leaf("x.test").is_err());
    }

    #[test]
    fn alpn_filter() {
        let offered = vec![b"h2".to_vec(), b"spdy/3".to_vec(), b"http/1.1".to_vec()];
        assert_eq!(supported_alpn(&offered), vec![b"h2".to_vec(), b"http/1.1".to_vec()]);
    }
}
