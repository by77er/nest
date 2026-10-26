//! `nest-proxy [--nestd-sock PATH] [--extra-root FILE.pem]... [--no-webpki-roots] [--max-connections N]`
//!
//! Runs unprivileged. All configuration beyond these flags arrives from nestd.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;

use nest_protocol::host::paths;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("NEST_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    let mut cfg = nest_proxy::Config::new(paths::PROXY_SOCK);
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--nestd-sock" => cfg.nestd_sock = PathBuf::from(args.next().context("--nestd-sock needs a path")?),
            "--extra-root" => {
                let path = args.next().context("--extra-root needs a file")?;
                let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(&path)
                    .with_context(|| format!("read {path}"))?
                    .collect::<Result<_, _>>()
                    .map_err(|e| anyhow::anyhow!("parse {path}: {e:?}"))?;
                cfg.extra_roots.extend(certs);
            }
            "--no-webpki-roots" => cfg.webpki_roots = false,
            "--max-connections" => cfg.max_connections = args.next().context("--max-connections needs a number")?.parse().context("--max-connections")?,
            "-h" | "--help" => {
                println!("nest-proxy [--nestd-sock PATH] [--extra-root FILE.pem]... [--no-webpki-roots] [--max-connections N]");
                return Ok(());
            }
            other => bail!("unknown argument {other}"),
        }
    }
    tracing::info!(sock = %cfg.nestd_sock.display(), "nest-proxy starting");
    nest_proxy::run(cfg).await
}
