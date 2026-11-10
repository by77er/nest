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
    /// After stdin is closed (idleness, a graceful stop): SIGKILL the process group if Claude Code
    /// hasn't exited this long after.
    pub exit_grace: Duration,
    /// Platform tool relay timeout (then `rate_limited`, retryable).
    pub tool_call_timeout: Duration,
    /// Wait for AgentDO's `tools_list` before falling back to the cached list.
    pub tools_list_timeout: Duration,
    /// Max wait for the session channel to open before reporting `agent_started` anyway.
    pub session_open_timeout: Duration,
    /// Hook spool drain interval.
    pub spool_interval: Duration,
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
            exit_grace: Duration::from_secs(30),
            tool_call_timeout: Duration::from_secs(150),
            tools_list_timeout: Duration::from_secs(10),
            session_open_timeout: Duration::from_secs(10),
            spool_interval: Duration::from_secs(5),
        }
    }
}

impl Config {
    /// Defaults overridden by `NEST_RUNNER_<FIELD>` (paths as-is, durations in ms, each clamped to
    /// its range in [`TIMERS`]).
    pub fn from_env() -> Self {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    /// [`Config::from_env`] over any variables. Pure but for the warnings it logs.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let mut c = Self::default();
        for (k, v) in [
            ("NEST_RUNNER_NESTD_SOCK", &mut c.nestd_sock),
            ("NEST_RUNNER_HOOK_DGRAM", &mut c.hook_dgram),
            ("NEST_RUNNER_HOOK_SOCK", &mut c.hook_sock),
            ("NEST_RUNNER_MCP_SOCK", &mut c.mcp_sock),
            ("NEST_RUNNER_CLAUDE_BIN", &mut c.claude_bin),
            ("NEST_RUNNER_NEST_BIN", &mut c.nest_bin),
            ("NEST_RUNNER_CWD", &mut c.cwd),
        ] {
            if let Some(s) = var(k) {
                *v = s.into();
            }
        }
        for ((k, lo, hi), v) in TIMERS.iter().zip(c.timers_mut()) {
            let Some(raw) = var(k) else { continue };
            match clamp_ms(&raw, *lo, *hi) {
                Some((d, clamped)) => {
                    if clamped {
                        tracing::warn!("{k}={raw} is out of range: using {} ms", d.as_millis());
                    }
                    *v = d;
                }
                None => tracing::warn!("{k}={raw} is not a number of ms: using the default {} ms", v.as_millis()),
            }
        }
        c
    }

    /// The overridable timers, in [`TIMERS`]' order.
    fn timers_mut(&mut self) -> [&mut Duration; 5] {
        [&mut self.idle_grace, &mut self.batch_interval, &mut self.tail_interval, &mut self.interrupt_grace, &mut self.exit_grace]
    }
}

/// Each `NEST_RUNNER_*_MS` override and the range it is clamped to: zero would panic a `tokio`
/// interval (batching, tailing) or make a grace meaningless, and a huge one overflow an `Instant`.
pub const TIMERS: [(&str, Duration, Duration); 5] = [
    ("NEST_RUNNER_IDLE_GRACE_MS", Duration::from_secs(1), Duration::from_secs(3600)),
    ("NEST_RUNNER_BATCH_MS", Duration::from_millis(10), Duration::from_secs(10)),
    ("NEST_RUNNER_TAIL_MS", Duration::from_millis(10), Duration::from_secs(10)),
    ("NEST_RUNNER_INTERRUPT_GRACE_MS", Duration::from_secs(1), Duration::from_secs(600)),
    ("NEST_RUNNER_EXIT_GRACE_MS", Duration::from_secs(1), Duration::from_secs(600)),
];

/// A millisecond override clamped to `lo..=hi`, and whether that changed it; none if it isn't a
/// whole number. Pure.
pub fn clamp_ms(raw: &str, lo: Duration, hi: Duration) -> Option<(Duration, bool)> {
    let asked = Duration::from_millis(raw.trim().parse::<u64>().ok()?);
    let d = asked.clamp(lo, hi);
    Some((d, d != asked))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_timer_override_is_clamped_to_its_range() {
        let (lo, hi) = (Duration::from_secs(1), Duration::from_secs(600));
        assert_eq!(clamp_ms("30000", lo, hi), Some((Duration::from_secs(30), false)));
        assert_eq!(clamp_ms("0", lo, hi), Some((lo, true)), "zero: the floor");
        assert_eq!(clamp_ms(&u64::MAX.to_string(), lo, hi), Some((hi, true)), "u64::MAX: the ceiling, no overflow");
        assert_eq!(clamp_ms(" 1000 ", lo, hi), Some((lo, false)), "the floor itself is in range");
        assert_eq!(clamp_ms("600000", lo, hi), Some((hi, false)));
        assert_eq!(clamp_ms("-5", lo, hi), None);
        assert_eq!(clamp_ms("30s", lo, hi), None);
    }

    /// Each override lands on its own field, clamped; one that isn't a number keeps the default.
    #[test]
    fn the_environment_overrides_each_field_within_its_range() {
        let vars = std::collections::HashMap::from([
            ("NEST_RUNNER_IDLE_GRACE_MS", "0".to_string()),
            ("NEST_RUNNER_BATCH_MS", "250".to_string()),
            ("NEST_RUNNER_TAIL_MS", "lots".to_string()),
            ("NEST_RUNNER_INTERRUPT_GRACE_MS", "2000".to_string()),
            ("NEST_RUNNER_EXIT_GRACE_MS", u64::MAX.to_string()),
            ("NEST_RUNNER_CWD", "/w".to_string()),
        ]);
        let c = Config::from_vars(|k| vars.get(k).cloned());
        let d = Config::default();
        assert_eq!(c.idle_grace, Duration::from_secs(1), "zero is clamped up");
        let top = |k: &str, ms: &str| Config::from_vars(|v| (v == k).then(|| ms.to_string()));
        assert_eq!(top("NEST_RUNNER_IDLE_GRACE_MS", "99999999").idle_grace, Duration::from_secs(3600), "an hour at most");
        assert_eq!(top("NEST_RUNNER_INTERRUPT_GRACE_MS", "99999999").interrupt_grace, Duration::from_secs(600), "ten minutes at most");
        assert_eq!(c.batch_interval, Duration::from_millis(250));
        assert_eq!(c.tail_interval, d.tail_interval, "not a number: the default");
        assert_eq!(c.interrupt_grace, Duration::from_secs(2));
        assert_eq!(c.exit_grace, Duration::from_secs(600), "u64::MAX is clamped down: no Instant overflow");
        assert_eq!(c.cwd, PathBuf::from("/w"));
        assert_eq!(c.nestd_sock, d.nestd_sock);
    }

    /// Every default is inside its override's range, and every range is sane (a positive floor, a
    /// ceiling an `Instant` takes easily).
    #[test]
    fn the_defaults_are_inside_the_ranges() {
        let mut c = Config::default();
        for ((k, lo, hi), d) in TIMERS.iter().zip(c.timers_mut()) {
            assert!(Duration::ZERO < *lo && *lo <= *d && *d <= *hi && *hi <= Duration::from_secs(3600), "{k}");
        }
    }
}
