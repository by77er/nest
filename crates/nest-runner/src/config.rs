//! Runner configuration. Production paths come from `nest_protocol::host::paths`; every path and
//! timing can be overridden with `NEST_RUNNER_*` environment variables (dev and tests).

use std::path::PathBuf;
use std::time::Duration;

use nest_protocol::host::paths;

#[derive(Clone, Debug)]
pub struct Config {
    /// nestd's runner socket (we connect).
    pub nestd_sock: PathBuf,
    /// Async tracking hooks (we bind, `SOCK_DGRAM`).
    pub hook_dgram: PathBuf,
    /// Sync decision hooks (we listen).
    pub hook_sock: PathBuf,
    /// `nest mcp` bridge (we listen).
    pub mcp_sock: PathBuf,
    /// The Claude Code binary.
    pub claude_bin: PathBuf,
    /// The `nest` binary written into the generated MCP config.
    pub nest_bin: PathBuf,
    /// Empty working directory for every Claude Code process.
    pub cwd: PathBuf,
    /// Close stdin this long after a turn ends with nothing queued.
    pub idle_grace: Duration,
    /// Agent event batching interval (1–2 s in production).
    pub batch_interval: Duration,
    /// Session-file poll interval.
    pub tail_interval: Duration,
    /// After an interrupt request: wait this long before SIGINT, and again before SIGKILL.
    pub interrupt_grace: Duration,
    /// Platform tool relay timeout (then `rate_limited`, retryable).
    pub tool_call_timeout: Duration,
    /// Wait for AgentDO's `tools_list` before falling back to the cached list.
    pub tools_list_timeout: Duration,
    /// Max wait for the session channel to open before reporting `agent_started` anyway.
    pub session_open_timeout: Duration,
    /// Hook spool drain interval.
    pub spool_interval: Duration,
    /// SessionStart: max time for reading the repo's CLAUDE.md through hands.
    pub session_start_read_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            nestd_sock: paths::RUNNER_SOCK.into(),
            hook_dgram: paths::HOOK_DGRAM.into(),
            hook_sock: paths::HOOK_SOCK.into(),
            mcp_sock: paths::MCP_SOCK.into(),
            claude_bin: "claude".into(),
            nest_bin: paths::NEST_BIN.into(),
            cwd: paths::EMPTY_CWD.into(),
            idle_grace: Duration::from_secs(120),
            batch_interval: Duration::from_millis(1500),
            tail_interval: Duration::from_millis(500),
            interrupt_grace: Duration::from_secs(10),
            tool_call_timeout: Duration::from_secs(150),
            tools_list_timeout: Duration::from_secs(10),
            session_open_timeout: Duration::from_secs(10),
            spool_interval: Duration::from_secs(5),
            session_start_read_timeout: Duration::from_secs(8),
        }
    }
}

impl Config {
    /// Defaults overridden by `NEST_RUNNER_<FIELD>` (paths as-is, durations in ms).
    pub fn from_env() -> Self {
        let mut c = Self::default();
        let path = |k: &str, v: &mut PathBuf| {
            if let Ok(s) = std::env::var(k) {
                *v = s.into();
            }
        };
        let ms = |k: &str, v: &mut Duration| {
            if let Some(n) = std::env::var(k).ok().and_then(|s| s.parse().ok()) {
                *v = Duration::from_millis(n);
            }
        };
        path("NEST_RUNNER_NESTD_SOCK", &mut c.nestd_sock);
        path("NEST_RUNNER_HOOK_DGRAM", &mut c.hook_dgram);
        path("NEST_RUNNER_HOOK_SOCK", &mut c.hook_sock);
        path("NEST_RUNNER_MCP_SOCK", &mut c.mcp_sock);
        path("NEST_RUNNER_CLAUDE_BIN", &mut c.claude_bin);
        path("NEST_RUNNER_NEST_BIN", &mut c.nest_bin);
        path("NEST_RUNNER_CWD", &mut c.cwd);
        ms("NEST_RUNNER_IDLE_GRACE_MS", &mut c.idle_grace);
        ms("NEST_RUNNER_BATCH_MS", &mut c.batch_interval);
        ms("NEST_RUNNER_TAIL_MS", &mut c.tail_interval);
        ms("NEST_RUNNER_INTERRUPT_GRACE_MS", &mut c.interrupt_grace);
        c
    }
}
