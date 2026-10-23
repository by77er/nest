//! cloudflared, nestd's child: the host's Cloudflare Tunnel (`docs/sandbox/gateway/`, Addressing).
//!
//! The control plane creates one tunnel per sandbox host at enrollment and hands nestd the tunnel
//! token, which is saved next to the host token (`credentials.rs`) whether or not cloudflared is
//! installed. With a configured binary, nestd runs `cloudflared --no-autoupdate tunnel run` as a
//! child whose environment is cleared down to `PATH`, `HOME` and the token in `TUNNEL_TOKEN` (which
//! cloudflared reads). The token is never on a command line, where `/proc/<pid>/cmdline` is
//! world-readable; `/proc/<pid>/environ` is readable only by the child's user and root, like the
//! credentials file. The child runs as `cloudflared_user` when configured: a different user from
//! nestd. Its output goes to nestd's log at info. It is restarted with a backoff whenever it exits
//! (a revoked token makes it exit at once, so that loop warns every 30 s), and at shutdown it gets
//! SIGTERM, then SIGKILL after 5 s. A token without a binary is logged every minute: the control
//! plane already advertises a tunnel URL for this host that nothing serves.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use nest_protocol::model::Secret;
use nix::unistd::{Gid, Uid};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::enroll::Enrolled;

/// First restart delay after an exit; doubles up to [`BACKOFF_MAX`]. A child that ran for at
/// least [`BACKOFF_MAX`] before exiting starts the ladder over.
pub const BACKOFF_MIN: Duration = Duration::from_secs(1);
pub const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// How long SIGTERM gets at shutdown before SIGKILL.
pub const STOP_GRACE: Duration = Duration::from_secs(5);
/// How often a token without a binary is logged.
pub const NAG_INTERVAL: Duration = Duration::from_secs(60);
/// Longer output lines are cut here and the rest of the line dropped.
const MAX_LINE: u64 = 64 * 1024;
/// A pipe that keeps failing to read is gone; stop after this many consecutive errors.
const MAX_READ_ERRORS: u32 = 8;

/// What to run.
#[derive(Clone)]
pub struct Tunnel {
    pub bin: PathBuf,
    pub token: Secret,
    /// Run the child as this uid and gid (from `cloudflared_user`); `None` keeps nestd's own.
    pub user: Option<(Uid, Gid)>,
    /// The child's `HOME`: a directory nestd creates, in which cloudflared finds no config file.
    pub home: PathBuf,
}

/// Delays, injectable for tests.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub stop_grace: Duration,
    pub nag_interval: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self { backoff_min: BACKOFF_MIN, backoff_max: BACKOFF_MAX, stop_grace: STOP_GRACE, nag_interval: NAG_INTERVAL }
    }
}

/// What this host does about its tunnel.
pub enum Plan {
    Run(Tunnel),
    /// Enrollment handed over a token but no binary is configured.
    TokenWithoutBinary,
    /// No token: this host has no tunnel (the harness, or a host that runs no sandboxes).
    Nothing,
}

/// Decide from config and enrollment. Fails when `cloudflared_user` names a user that does not
/// exist: running the tunnel as nestd instead would be a silent downgrade.
pub fn plan(cfg: &Config, enrolled: &Enrolled) -> anyhow::Result<Plan> {
    let Some(token) = enrolled.tunnel_token.clone() else { return Ok(Plan::Nothing) };
    let Some(bin) = cfg.cloudflared_bin.clone() else { return Ok(Plan::TokenWithoutBinary) };
    let user = match &cfg.cloudflared_user {
        Some(name) => {
            let u = nix::unistd::User::from_name(name)?.ok_or_else(|| anyhow::anyhow!("cloudflared_user {name:?} does not exist"))?;
            Some((u.uid, u.gid))
        }
        None => None,
    };
    Ok(Plan::Run(Tunnel { bin, token, user, home: cfg.state_dir.join("cloudflared") }))
}

/// The running supervisor. [`Supervisor::stop`] shuts the child down gracefully. Dropping it
/// instead cancels the task, which still terminates the child in the background while the runtime
/// runs, and the child is killed outright if the task is dropped.
pub struct Supervisor {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Supervisor {
    /// SIGTERM the child, SIGKILL it after the grace, and return once it is gone.
    pub async fn stop(mut self) {
        self.stop.cancel();
        let _ = (&mut self.task).await;
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Start the plan in the background: `None` when there is nothing to do.
pub fn spawn(plan: Plan) -> Option<Supervisor> {
    spawn_with(plan, Timing::default())
}

pub fn spawn_with(plan: Plan, timing: Timing) -> Option<Supervisor> {
    let stop = CancellationToken::new();
    let task = match plan {
        Plan::Nothing => return None,
        Plan::TokenWithoutBinary => tokio::spawn(nag(timing.nag_interval, stop.clone())),
        Plan::Run(tunnel) => tokio::spawn(supervise(tunnel, timing, stop.clone())),
    };
    Some(Supervisor { stop, task })
}

async fn nag(interval: Duration, stop: CancellationToken) {
    loop {
        tracing::warn!("enrollment gave this host a tunnel token but no cloudflared_bin is configured: the control plane advertises a gateway URL that nothing serves");
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = stop.cancelled() => return,
        }
    }
}

/// Spawn, forward output, wait, back off, again; until cancelled, when the child is terminated.
async fn supervise(tunnel: Tunnel, timing: Timing, stop: CancellationToken) {
    let mut backoff = timing.backoff_min;
    loop {
        let started = Instant::now();
        match start(&tunnel) {
            Ok(mut child) => {
                tracing::info!(bin = %tunnel.bin.display(), pid = child.id().unwrap_or(0), "cloudflared started");
                if let Some(out) = child.stdout.take() {
                    tokio::spawn(forward(out));
                }
                if let Some(err) = child.stderr.take() {
                    tokio::spawn(forward(err));
                }
                tokio::select! {
                    status = child.wait() => match status {
                        Ok(status) => tracing::warn!(%status, "cloudflared exited"),
                        Err(e) => tracing::warn!("waiting for cloudflared: {e}"),
                    },
                    () = stop.cancelled() => {
                        terminate(&mut child, timing.stop_grace).await;
                        return;
                    }
                }
            }
            Err(e) => tracing::warn!(bin = %tunnel.bin.display(), "cloudflared failed to start: {e}"),
        }
        if started.elapsed() >= timing.backoff_max {
            backoff = timing.backoff_min;
        }
        tokio::select! {
            () = tokio::time::sleep(backoff) => {}
            () = stop.cancelled() => return,
        }
        backoff = (backoff * 2).min(timing.backoff_max);
    }
}

fn start(t: &Tunnel) -> std::io::Result<Child> {
    std::fs::create_dir_all(&t.home)?;
    let path = std::env::var_os("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
    let mut cmd = Command::new(&t.bin);
    cmd.args(["--no-autoupdate", "tunnel", "run"])
        .env_clear()
        .env("PATH", path)
        .env("HOME", &t.home)
        .env("TUNNEL_TOKEN", t.token.expose())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some((uid, gid)) = t.user {
        cmd.uid(uid.as_raw()).gid(gid.as_raw());
    }
    cmd.spawn()
}

/// SIGTERM, then SIGKILL after `grace`.
async fn terminate(child: &mut Child, grace: Duration) {
    if let Some(pid) = child.id().and_then(|p| i32::try_from(p).ok())
        && let Err(e) = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGTERM)
    {
        tracing::warn!("SIGTERM to cloudflared: {e}");
    }
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(Ok(status)) => tracing::info!(%status, "cloudflared stopped"),
        Ok(Err(e)) => tracing::warn!("waiting for cloudflared: {e}"),
        Err(_) => {
            tracing::warn!("cloudflared ignored SIGTERM for {grace:?}; killing it");
            if let Err(e) = child.kill().await {
                tracing::warn!("SIGKILL to cloudflared: {e}");
            }
        }
    }
}

/// cloudflared's output, one tracing event per line, until the pipe closes. Bytes, not UTF-8
/// strings: a bad byte must not end the reader, or the child blocks on a full pipe and the tunnel
/// stalls without ever exiting. Lines over 64 KiB are cut.
async fn forward<R: AsyncRead + Unpin>(r: R) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    let mut errors = 0u32;
    loop {
        buf.clear();
        match (&mut reader).take(MAX_LINE).read_until(b'\n', &mut buf).await {
            Ok(0) => return,
            Ok(_) => {
                errors = 0;
                let cut = buf.last() != Some(&b'\n') && buf.len() as u64 >= MAX_LINE;
                if cut {
                    skip_line(&mut reader).await;
                }
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\r', '\n']);
                if cut {
                    tracing::info!(target: "cloudflared", "{line} [line cut at 64 KiB]");
                } else {
                    tracing::info!(target: "cloudflared", "{line}");
                }
            }
            Err(e) => {
                errors += 1;
                tracing::warn!("reading cloudflared output: {e}");
                if errors >= MAX_READ_ERRORS {
                    return;
                }
            }
        }
    }
}

/// Drop the rest of an over-long line.
async fn skip_line<R: AsyncBufRead + Unpin>(reader: &mut R) {
    let mut scratch = Vec::new();
    loop {
        scratch.clear();
        match (&mut *reader).take(MAX_LINE).read_until(b'\n', &mut scratch).await {
            Ok(0) | Err(_) => return,
            Ok(_) if scratch.last() == Some(&b'\n') => return,
            Ok(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Captured tracing output for the current thread (these tests run on one thread).
    #[derive(Clone, Default)]
    struct Logs(Arc<Mutex<Vec<u8>>>);

    impl Logs {
        fn install(&self) -> tracing::subscriber::DefaultGuard {
            tracing::subscriber::set_default(tracing_subscriber::fmt().with_writer(self.clone()).with_ansi(false).without_time().finish())
        }
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
        fn count(&self, needle: &str) -> usize {
            self.text().matches(needle).count()
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
        type Writer = LogsWriter;
        fn make_writer(&'a self) -> LogsWriter {
            LogsWriter(self.0.clone())
        }
    }

    struct LogsWriter(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for LogsWriter {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A fake cloudflared: a shell script whose prologue appends `spawned pid=<pid> at=<ns>
    /// argv:<args>` to the log and sets `$n` to this run's number; the body (given the log's path)
    /// follows. The token's value is never written anywhere.
    struct Fake {
        dir: tempfile::TempDir,
        log: PathBuf,
    }

    struct Spawned {
        pid: i32,
        at: Duration,
    }

    impl Fake {
        fn new(body: impl Fn(&str) -> String) -> Fake {
            let dir = tempfile::tempdir().unwrap();
            let log = dir.path().join("log");
            let l = log.display().to_string();
            let script = format!("#!/bin/sh\necho \"spawned pid=$$ at=$(date +%s%N) argv:$*\" >> {l}\nn=$(grep -c '^spawned' {l})\n{}\n", body(&l));
            std::fs::write(dir.path().join("cloudflared"), script).unwrap();
            std::fs::set_permissions(dir.path().join("cloudflared"), std::fs::Permissions::from_mode(0o755)).unwrap();
            Fake { dir, log }
        }
        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }
        fn tunnel(&self, token: &str) -> Tunnel {
            Tunnel { bin: self.path("cloudflared"), token: Secret(token.into()), user: None, home: self.path("home") }
        }
        fn text(&self) -> String {
            std::fs::read_to_string(&self.log).unwrap_or_default()
        }
        fn spawns(&self) -> Vec<Spawned> {
            self.text()
                .lines()
                .filter_map(|l| l.strip_prefix("spawned pid="))
                .map(|l| {
                    let (pid, rest) = l.split_once(" at=").unwrap();
                    let (at, _) = rest.split_once(" argv:").unwrap();
                    Spawned { pid: pid.parse().unwrap(), at: Duration::from_nanos(at.parse().unwrap()) }
                })
                .collect()
        }
        async fn wait_spawns(&self, n: usize) -> Vec<Spawned> {
            wait_for(&format!("{n} spawns"), || self.spawns().len() >= n).await;
            self.spawns()
        }
    }

    async fn wait_for(what: &str, f: impl Fn() -> bool) {
        for _ in 0..600 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// Whether `pid` is a live process (a zombie counts as dead).
    fn alive(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/status")) {
            Ok(s) => !s.lines().any(|l| l.starts_with("State:") && l.contains('Z')),
            Err(_) => false,
        }
    }

    /// NUL-separated strings from `/proc/<pid>/<file>` (`cmdline`, `environ`).
    fn proc_strings(pid: i32, file: &str) -> Vec<String> {
        let raw = std::fs::read(format!("/proc/{pid}/{file}")).unwrap();
        raw.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
    }

    fn timing(min_ms: u64, max_ms: u64) -> Timing {
        Timing { backoff_min: Duration::from_millis(min_ms), backoff_max: Duration::from_millis(max_ms), stop_grace: Duration::from_millis(300), nag_interval: Duration::from_millis(50) }
    }

    /// The child stays up until SIGTERM, which it records.
    fn trap_term_and_wait(log: &str) -> String {
        format!("trap 'echo term >> {log}; exit 0' TERM\nwhile :; do sleep 0.1; done")
    }

    fn config(json: serde_json::Value) -> Config {
        let mut base = serde_json::json!({
            "role": "burst", "cell": "c", "enrollment": {"type": "aws_imds"},
            "driver": {"type": "process", "guest_command": ["x"]}, "state_dir": "/var/lib/nest-test",
        });
        base.as_object_mut().unwrap().extend(json.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn enrolled(token: Option<&str>) -> Enrolled {
        Enrolled {
            host: nest_protocol::model::HostId("hst_t".into()),
            host_token: Secret("h".into()),
            host_token_expires_ms: i64::MAX,
            fleet_ws_url: "wss://cp/v1/fleet".into(),
            proxy_ca: None,
            tunnel_token: token.map(|t| Secret(t.into())),
            gateway_url: None,
        }
    }

    /// The child's exact command line and environment, read from `/proc`: the token reaches it in
    /// `TUNNEL_TOKEN` and nowhere else, nothing of nestd's environment does; an exit is followed by
    /// a restart; stopping sends SIGTERM, which the child sees before it is gone.
    #[tokio::test]
    async fn child_gets_only_token_path_and_home_restarts_after_an_exit_and_gets_sigterm_on_stop() {
        let fake = Fake::new(|log| format!("if [ \"$n\" = 1 ]; then exit 0; fi\n{}", trap_term_and_wait(log)));
        let token = "tok-secret-value";
        let sup = spawn_with(Plan::Run(fake.tunnel(token)), timing(100, 400)).unwrap();
        // The first run exited at once; the second is the restart, still running.
        let spawns = fake.wait_spawns(2).await;
        let pid = spawns[1].pid;
        assert!(alive(pid));
        let argv = proc_strings(pid, "cmdline");
        assert_eq!(argv[2..], ["--no-autoupdate", "tunnel", "run"], "{argv:?}");
        assert!(argv.iter().all(|a| !a.contains(token)), "{argv:?}");
        let mut env = proc_strings(pid, "environ");
        env.sort();
        let names: Vec<&str> = env.iter().map(|e| e.split_once('=').unwrap().0).collect();
        assert_eq!(names, ["HOME", "PATH", "TUNNEL_TOKEN"], "{env:?}");
        assert!(env.contains(&format!("TUNNEL_TOKEN={token}")));
        assert!(env.contains(&format!("HOME={}", fake.path("home").display())));
        assert!(fake.path("home").is_dir());
        assert!(!fake.text().contains(token), "the fake never had the value anywhere it could write it");
        sup.stop().await;
        assert!(fake.text().ends_with("\nterm\n"), "SIGTERM reached the child: {}", fake.text());
        assert!(!alive(pid));
    }

    /// Restart delays: 150, 300, 600 (the cap), 600; a run that lasts at least the cap resets the
    /// ladder, so the next delays are 150 and 300 again. Measured between the children's own start
    /// timestamps; each bound is at least 100 ms away from the behavior it rules out.
    #[tokio::test]
    async fn backoff_doubles_to_the_cap_and_resets_after_a_long_run() {
        let fake = Fake::new(|_| "if [ \"$n\" = 5 ]; then sleep 0.7; fi\nexit 0".into());
        let sup = spawn_with(Plan::Run(fake.tunnel("t")), timing(150, 600)).unwrap();
        let s = fake.wait_spawns(7).await;
        drop(sup);
        let gap = |i: usize| s[i].at - s[i - 1].at;
        let ms = |d: Duration| d.as_millis();
        let gaps: Vec<u128> = (1..7).map(|i| ms(gap(i))).collect();
        assert!(gaps[0] >= 150 && gaps[0] < 300, "first delay is the minimum: {gaps:?}");
        assert!(gaps[1] >= 300 && gaps[1] < 600, "then doubled: {gaps:?}");
        assert!(gaps[2] >= 600 && gaps[2] < 900, "then the cap: {gaps:?}");
        assert!(gaps[3] >= 600 && gaps[3] < 900, "and stays at the cap, not 1200: {gaps:?}");
        // Run 5 lasted 700 ms ≥ the cap: the delay after it is the minimum again (700 + 150), not
        // 700 + 600.
        assert!(gaps[4] >= 850 && gaps[4] < 1100, "reset after a long run: {gaps:?}");
        assert!(gaps[5] >= 300 && gaps[5] < 500, "and the ladder restarts from the minimum: {gaps:?}");
    }

    /// Output is forwarded as bytes: a line that is not UTF-8 does not end the reader, an over-long
    /// line is cut, and the child never blocks on a full pipe (300 KB of output, more than a pipe
    /// holds, then a marker file).
    #[tokio::test]
    async fn output_is_drained_past_bad_bytes_and_long_lines() {
        let logs = Logs::default();
        let _guard = logs.install();
        let fake = Fake::new(|log| {
            let marker = Path::new(log).with_file_name("marker");
            format!("printf 'bad \\377\\376 bytes\\n'\nhead -c 300000 /dev/zero | tr '\\0' a\necho\necho after-the-long-line\ntouch {}\n{}", marker.display(), trap_term_and_wait(log))
        });
        let sup = spawn_with(Plan::Run(fake.tunnel("t")), timing(100, 400)).unwrap();
        wait_for("the child to get past its output", || fake.path("marker").exists()).await;
        wait_for("the last line to be forwarded", || logs.count("after-the-long-line") == 1).await;
        let text = logs.text();
        assert!(text.contains("bad \u{FFFD}\u{FFFD} bytes"), "{text}");
        assert_eq!(logs.count("[line cut at 64 KiB]"), 1, "{text}");
        assert!(text.lines().all(|l| l.len() < 70_000), "no forwarded line is longer than the cap");
        sup.stop().await;
    }

    /// A non-zero exit is logged with its status and followed by a restart.
    #[tokio::test]
    async fn a_non_zero_exit_is_logged_and_followed_by_a_restart() {
        let logs = Logs::default();
        let _guard = logs.install();
        let fake = Fake::new(|_| "exit 3".into());
        let sup = spawn_with(Plan::Run(fake.tunnel("t")), timing(50, 400)).unwrap();
        fake.wait_spawns(2).await;
        drop(sup);
        let text = logs.text();
        assert!(text.contains("cloudflared exited") && text.contains("exit status: 3"), "{text}");
    }

    /// A binary that cannot be started is logged on every attempt and retried with the backoff.
    #[tokio::test]
    async fn a_missing_binary_is_logged_and_retried() {
        let logs = Logs::default();
        let _guard = logs.install();
        let dir = tempfile::tempdir().unwrap();
        let tunnel = Tunnel { bin: dir.path().join("absent"), token: Secret("t".into()), user: None, home: dir.path().join("home") };
        let sup = spawn_with(Plan::Run(tunnel), timing(50, 400)).unwrap();
        wait_for("two failed starts", || logs.count("cloudflared failed to start") >= 2).await;
        drop(sup);
        assert!(logs.text().contains(&dir.path().join("absent").display().to_string()));
    }

    /// A child that ignores SIGTERM is killed once the grace is over, and `stop` still returns.
    #[tokio::test]
    async fn sigkill_follows_an_ignored_sigterm() {
        let logs = Logs::default();
        let _guard = logs.install();
        let fake = Fake::new(|_| "trap '' TERM\nwhile :; do sleep 0.1; done".into());
        let sup = spawn_with(Plan::Run(fake.tunnel("t")), timing(100, 400)).unwrap();
        let pid = fake.wait_spawns(1).await[0].pid;
        let t0 = Instant::now();
        sup.stop().await;
        assert!(t0.elapsed() >= Duration::from_millis(300), "the grace was given: {:?}", t0.elapsed());
        assert!(!alive(pid));
        assert!(logs.text().contains("ignored SIGTERM"), "{}", logs.text());
    }

    /// With `cloudflared_user` set, the child runs as that user (here the test's own, the only one
    /// an unprivileged test can switch to).
    #[tokio::test]
    async fn runs_as_the_configured_user() {
        let me = nix::unistd::User::from_uid(nix::unistd::getuid()).unwrap().unwrap();
        let cfg = config(serde_json::json!({"cloudflared_bin": "/x", "cloudflared_user": me.name}));
        let Plan::Run(planned) = plan(&cfg, &enrolled(Some("t"))).unwrap() else { panic!("not planned to run") };
        assert_eq!(planned.user, Some((me.uid, me.gid)));
        let fake = Fake::new(|log| format!("id -u >> {log}\nexit 0"));
        let tunnel = Tunnel { user: planned.user, ..fake.tunnel("t") };
        let sup = spawn_with(Plan::Run(tunnel), timing(100, 400)).unwrap();
        fake.wait_spawns(1).await;
        wait_for("the child's uid", || fake.text().contains(&format!("\n{}\n", me.uid.as_raw()))).await;
        drop(sup);
    }

    /// Nothing without a token; a token without a binary is a warning repeated at the interval;
    /// a user that does not exist is a configuration error.
    #[tokio::test]
    async fn a_token_without_a_binary_is_logged_repeatedly_and_other_plans() {
        let logs = Logs::default();
        let _guard = logs.install();
        assert!(matches!(plan(&config(serde_json::json!({})), &enrolled(None)).unwrap(), Plan::Nothing));
        assert!(matches!(plan(&config(serde_json::json!({"cloudflared_bin": "/x"})), &enrolled(None)).unwrap(), Plan::Nothing));
        let Plan::Run(t) = plan(&config(serde_json::json!({"cloudflared_bin": "/x"})), &enrolled(Some("tok"))).unwrap() else { panic!("not planned to run") };
        assert_eq!((t.bin.as_path(), t.token.expose(), t.user, t.home.as_path()), (Path::new("/x"), "tok", None, Path::new("/var/lib/nest-test/cloudflared")));
        let err = plan(&config(serde_json::json!({"cloudflared_bin": "/x", "cloudflared_user": "no-such-user-nest"})), &enrolled(Some("tok"))).err().unwrap();
        assert!(err.to_string().contains("no-such-user-nest"), "{err}");
        assert!(spawn_with(Plan::Nothing, timing(50, 400)).is_none());
        let p = plan(&config(serde_json::json!({})), &enrolled(Some("tok"))).unwrap();
        assert!(matches!(p, Plan::TokenWithoutBinary));
        let sup = spawn_with(p, timing(50, 400)).unwrap();
        wait_for("the warning to repeat", || logs.count("no cloudflared_bin is configured") >= 2).await;
        sup.stop().await;
    }
}
