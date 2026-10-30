//! nestd: the privileged per-host daemon (`docs/compute/nestd/`).

use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use nestd::config::Config;

#[derive(Parser)]
#[command(version, about = "nest host daemon")]
struct Args {
    /// Path to the JSON config file.
    #[arg(long, default_value = "/etc/nest/nestd.json")]
    config: PathBuf,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();
    let args = Args::parse();
    let text = std::fs::read_to_string(&args.config).with_context(|| format!("read {}", args.config.display()))?;
    let cfg: Config = serde_json::from_str(&text).with_context(|| format!("parse {}", args.config.display()))?;
    cfg.validate().with_context(|| format!("check {}", args.config.display()))?;
    // Into the delegated cgroup's leaf before the runtime starts any thread or child (a failure is
    // reported, never fatal: see `cgroup::delegate`).
    if cfg.delegated_cgroup
        && let Err(e) = nestd::cgroup::delegate(&cfg.cgroup_root)
    {
        tracing::error!(error = %e, "cgroup delegation failed: VMMs will run outside the unit's cgroup");
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run(cfg))
}

async fn run(cfg: Config) -> anyhow::Result<()> {
    // Pick rustls's provider explicitly: a workspace build that includes nest-proxy also enables
    // `ring`, and with two providers compiled in rustls panics at the first TLS connection.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tokio::spawn(watch_invariants());
    let enrolled = nestd::enroll::enroll(&cfg).await.context("enrollment")?;
    tracing::info!(host = %enrolled.host, fleet = %enrolled.fleet_ws_url, tunnel_url = enrolled.gateway_url.as_deref().unwrap_or("-"), tunnel = enrolled.tunnel_token.is_some(), "enrolled");
    let host = nestd::host::Host::start(cfg, enrolled, None).await?;
    tracing::info!(host = %host.inner.host_id(), "nestd running");
    // systemd stops nestd with SIGTERM; the terminal with SIGINT. Either way the children go too.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        r = tokio::signal::ctrl_c() => r?,
        _ = term.recv() => {}
    }
    tracing::info!("shutting down");
    host.shutdown().await;
    Ok(())
}

/// A core invariant that fails in a release build is never fatal (a test build panics on it). One
/// checked inside a step comes back as an effect its shell logs (`fleet.rs`, `Log::InvariantViolated`);
/// one checked outside a step (`ResultCache::insert`) is only counted, so this logs each rise of
/// the count (`nestd_core::invariant`).
async fn watch_invariants() {
    let mut seen = 0;
    let mut every = tokio::time::interval(std::time::Duration::from_secs(10));
    loop {
        every.tick().await;
        let total = nestd_core::invariant::violations();
        if total > seen {
            tracing::error!(new = total - seen, total, "core invariant violated outside a step");
            seen = total;
        }
    }
}
