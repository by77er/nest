fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    // As in nestd: choose rustls's provider, whatever else the build enabled.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(nest_runner::run(nest_runner::Config::from_env()))
}
