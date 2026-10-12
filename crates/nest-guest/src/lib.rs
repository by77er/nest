//! nest guest agent: the hands server inside every sandbox VM.
//!
//! Spec: `docs/interfaces/host-guest/`. Listens on vsock ports 1024 (control), 1025 (hands RPC,
//! one connection per call) and 10000 (ingress), plus the in-sandbox CLI socket.

pub mod cgroup;
pub mod cli;
pub mod control;
pub mod exec;
pub mod framed;
pub mod hands;
pub mod ingress;
pub mod output;
pub mod ports;
pub mod state;
pub mod sys;
pub mod tasks;
pub mod transport;

use std::sync::Arc;

use nest_protocol::guest::{PORT_CONTROL, PORT_HANDS, PORT_INGRESS};
use tokio::task::JoinSet;
use tracing::warn;

pub use state::{Config, Guest};
pub use transport::ListenSpec;

/// A running guest agent. Dropping it stops all accept loops.
pub struct Running {
    pub guest: Arc<Guest>,
    tasks: JoinSet<()>,
}

impl Running {
    /// Wait until an accept loop fails (normally never).
    pub async fn wait(mut self) {
        while self.tasks.join_next().await.is_some() {}
    }
}

/// Bind every listener and start serving.
pub async fn start(config: Config) -> std::io::Result<Running> {
    let guest = Guest::new(config.clone());
    let mut tasks = JoinSet::new();
    for port in [PORT_CONTROL, PORT_HANDS, PORT_INGRESS] {
        let listener = transport::PortListener::bind(&config.listen, port)?;
        let g = guest.clone();
        tasks.spawn(async move {
            loop {
                let conn = match listener.accept().await {
                    Ok(c) => c,
                    Err(e) => {
                        warn!(port, error = %e, "accept failed");
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let g = g.clone();
                match port {
                    PORT_CONTROL => tokio::spawn(control::serve(g, conn)),
                    PORT_HANDS => tokio::spawn(hands::serve(g, conn)),
                    _ => tokio::spawn(ingress::serve(g, conn)),
                };
            }
        });
    }
    if let Some(path) = &config.cli_socket {
        match cli::bind(path) {
            Ok(l) => {
                tasks.spawn(cli::accept_loop(guest.clone(), l));
            }
            Err(e) => warn!(path = %path.display(), error = %e, "cli socket unavailable"),
        }
    }
    tasks.spawn(ports::watch(guest.clone()));
    Ok(Running { guest, tasks })
}
