//! nest agent runner: runs Claude Code brains on a host.
//!
//! Spec: `docs/agents/runner/`, `docs/interfaces/host-internal/` (nestd-runner, runner-hooks,
//! runner-mcp, runner-claude), `docs/interfaces/control-host/session/`.
//!
//! | Socket | Role |
//! |---|---|
//! | nestd `runner.sock` | lifecycle (we connect): [`supervisor`] |
//! | `hook.dgram` / `hook.sock` | async tracking / sync decisions (we serve): [`hooks`] |
//! | `mcp.sock` | `nest mcp` bridge (we serve): [`mcp`] |
//! | AgentDO WebSocket | one per active agent (turns, events, platform tools, `hands_resolve`): [`session`] |
//! | the sandbox's gateway (WebSocket, via `nest-hands-client`) | hands RPC per tool call, with the target from AgentDO's `hands_resolve`: [`hands`] |

pub mod agent;
pub mod config;
pub mod framing;
pub mod hands;
pub mod hooks;
pub mod mcp;
pub mod rules;
pub mod runtime;
pub mod session;
pub mod stream;
pub mod supervisor;
pub mod tailer;
#[doc(hidden)]
pub mod test_support;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

pub use config::Config;
pub use runtime::Runtime;

/// Bind the hook and MCP sockets, then run until the process is killed.
pub async fn run(cfg: Config) -> anyhow::Result<()> {
    let rt = Runtime::new(cfg);
    serve(rt).await
}

/// Like [`run`] with an existing runtime (tests inspect it).
pub async fn serve(rt: Arc<Runtime>) -> anyhow::Result<()> {
    let cfg = &rt.cfg;
    let dgram = tokio::net::UnixDatagram::bind(fresh(&cfg.hook_dgram)?)?;
    let hook_sock = tokio::net::UnixListener::bind(fresh(&cfg.hook_sock)?)?;
    let mcp_sock = tokio::net::UnixListener::bind(fresh(&cfg.mcp_sock)?)?;
    for p in [&cfg.hook_dgram, &cfg.hook_sock, &cfg.mcp_sock] {
        // Group `nest-agents` (set by the unit) may connect; nobody else.
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o660))?;
    }
    tokio::spawn(hooks::serve_dgram(rt.clone(), dgram));
    tokio::spawn(hooks::serve_sync(rt.clone(), hook_sock));
    tokio::spawn(mcp::serve(rt.clone(), mcp_sock));
    tokio::spawn(supervisor::lease_watchdog(rt.clone()));
    supervisor::run(rt).await;
    Ok(())
}

/// Remove a stale socket file and make sure the parent exists.
fn fresh(p: &Path) -> std::io::Result<&Path> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::remove_file(p) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    Ok(p)
}
