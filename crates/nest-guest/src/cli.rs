//! In-sandbox `nest` CLI endpoint (`/run/nest/guest.sock`): answers `whoami`, relays the rest.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use nest_protocol::guest::{CliCommand, CliRequest, CliResponse, CliResult};
use tokio::net::UnixListener;
use tracing::warn;

use crate::framed::{FramedReader, write_json};
use crate::state::{Gate, Guest};

pub fn bind(path: &Path) -> std::io::Result<UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let l = UnixListener::bind(path)?;
    // Any process in the sandbox may use the CLI.
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666));
    Ok(l)
}

pub async fn accept_loop(guest: Arc<Guest>, listener: UnixListener) {
    loop {
        match listener.accept().await {
            Ok((s, _)) => {
                tokio::spawn(handle(guest.clone(), s));
            }
            Err(e) => {
                warn!(error = %e, "cli accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn handle(guest: Arc<Guest>, stream: tokio::net::UnixStream) {
    let mut reader = FramedReader::new(stream);
    let req: CliRequest = match reader.next_json().await {
        Ok(Some(Ok(r))) => r,
        Ok(Some(Err(e))) => {
            let (mut s, _) = reader.into_parts();
            let _ = write_json(&mut s, &CliResponse { result: CliResult::Error { error: e } }).await;
            return;
        }
        _ => return,
    };
    let result = execute(&guest, req).await;
    let (mut s, _) = reader.into_parts();
    let _ = write_json(&mut s, &CliResponse { result }).await;
}

pub async fn execute(guest: &Guest, req: CliRequest) -> CliResult {
    match req.command {
        CliCommand::Whoami {} => {
            let inner = guest.inner.lock().unwrap();
            match inner.admit(Gate::Whoami) {
                Ok(id) => CliResult::Ok {
                    data: serde_json::json!({ "sandbox_id": id.sandbox_id, "agent_id": req.agent_id, "epoch": id.epoch }),
                },
                Err(error) => CliResult::Error { error },
            }
        }
        command => {
            let wait = match &command {
                CliCommand::Ask { wait_s, .. } => Duration::from_secs(u64::from((*wait_s).min(120)) + 15),
                _ => Duration::from_secs(30),
            };
            guest.relay_cli(req.agent_id, command, wait).await
        }
    }
}
