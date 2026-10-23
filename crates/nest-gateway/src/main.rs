use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;

/// The sandbox gateway: WebSocket in, host-guest frames out to the guest's vsock port.
#[derive(Parser, Debug)]
#[command(name = "nest-gateway")]
struct Args {
    /// Address to accept WebSockets on (loopback behind cloudflared on a real host).
    #[arg(long, default_value = "127.0.0.1:18790")]
    listen: String,
    /// nestd's gateway socket, which feeds keys and sandboxes.
    #[arg(long, default_value = nest_protocol::host::paths::GATEWAY_SOCK)]
    nestd_sock: PathBuf,
}

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let args = Args::parse();
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(&args.listen).await?;
        let listen = listener.local_addr()?.to_string();
        tracing::info!(%listen, nestd_sock = %args.nestd_sock.display(), "nest-gateway listening");
        let state = Arc::new(nest_gateway::State::default());
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            r = nest_gateway::serve(listener, Arc::clone(&state)) => r.map_err(anyhow::Error::from),
            _ = nest_gateway::link(args.nestd_sock, listen, Arc::clone(&state)) => Ok(()),
            _ = term.recv() => {
                // Cut every call and let the close frames go out before the process does.
                tracing::info!("SIGTERM: closing every connection");
                let left = nest_gateway::shutdown(&state).await;
                if left > 0 {
                    tracing::warn!(left, "connections still open at the shutdown cap");
                }
                Ok(())
            }
        }
    })
}
