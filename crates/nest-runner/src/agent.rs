//! One brain: prepare the config dir, verify auth, spawn Claude Code, drive stream-json, and
//! report lifecycle to nestd.
//!
//! Lifecycle rules (see `docs/interfaces/host-internal/nestd-runner/`):
//! - A start registers the agent **first**, so `fence`/`agent_stop`/lease lapse reach it during
//!   the slow startup steps (each has a timeout and is cancellable); a duplicate start never
//!   touches the live brain.
//! - Kills never wait on the actor or on Claude Code's stdin ([`Agent::kill_now`]); stdin is
//!   written by its own task.
//! - A turn or inbox message arriving after stdin was closed for idleness restarts Claude Code
//!   with `--resume` and replays it; after a stop/kill it is reported as an error event, never
//!   silently dropped.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use nest_protocol::control::{SegmentRef, SessionResume};
use nest_protocol::host::claude::{self, SessionArgs, StreamIn, StreamOut, SystemMessage};
use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerEvent, StopMode};
use nest_protocol::control::LaunchConfig;
use nest_protocol::model::{AgentEventBody, AgentState, ErrorBody, SessionId, TurnInputKind};
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::framing;
use crate::runtime::{Agent, AgentCmd, Outbound, Runtime};
use crate::session;
use crate::stream;

/// `system/init.capabilities` flag for the stream-json interrupt control request.
pub const CAP_INTERRUPT: &str = "interrupt_receipt_v1";

/// The only Claude Code built-ins a brain may have: none reads or writes the host's files or
/// runs a command there (its hands are the `mcp__nest__*` tools that run inside the sandbox).
/// Subagents (`Agent`, `Task` before Claude Code 2.1), the task and todo tools (state in the
/// config dir), the web tools (traffic through the host's egress allowlist), and the MCP
/// resource tools (they read only from the configured `nest` server). An allowlist, so a
/// built-in Claude Code adds later is refused until it is reviewed and listed here.
pub const HOST_SAFE_BUILTINS: &[&str] = &[
    "Agent", "Task", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TodoWrite", "WebSearch", "WebFetch",
    "ListMcpResourcesTool", "ReadMcpResourceTool",
];

/// Whether a tool name is allowed in a brain: an MCP tool (every one comes through `nest mcp`)
/// or a [`HOST_SAFE_BUILTINS`] entry.
pub fn tool_allowed(name: &str) -> bool {
    name.starts_with("mcp__") || HOST_SAFE_BUILTINS.contains(&name)
}

const MATERIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// How long to wait for a previous connection's brain (being killed) to go away.
const DYING_WAIT: Duration = Duration::from_secs(10);
/// Pending stdin messages per brain before a write is refused.
const STDIN_QUEUE: usize = 64;
/// After a `result` while more user messages are outstanding: if Claude Code shows no further
/// activity for this long, treat the queue as merged into that turn.
const SETTLE: Duration = Duration::from_secs(10);

/// Start an agent in the background. Errors are reported to nestd.
pub fn start(rt: Arc<Runtime>, start: AgentStart) {
    tokio::spawn(async move {
        let id = start.start.agent.clone();
        if let Some(bad) = start.start.launch.builtin_tools.iter().find(|t| !HOST_SAFE_BUILTINS.contains(&t.as_str())) {
            let msg = format!("refusing to start: built-in tool {bad} is not on the runner's host-safe allowlist");
            tracing::error!(agent = %id, "{msg}");
            rt.report(RunnerEvent::Error { agent: Some(id.clone()), error: ErrorBody { code: "forbidden_tool".into(), message: msg, retryable: false } });
            rt.report(RunnerEvent::AgentExited { agent: id, code: None, signal: None, reason: ExitReason::Crashed, epoch: Some(start.start.agent_epoch()) });
            return;
        }
        if !rt.lease_valid() {
            rt.report(RunnerEvent::Error {
                agent: Some(id.clone()),
                error: ErrorBody { code: "no_lease".into(), message: "no valid host lease; refusing to start a brain".into(), retryable: true },
            });
            rt.report(RunnerEvent::AgentExited { agent: id, code: None, signal: None, reason: ExitReason::Fenced, epoch: Some(start.start.agent_epoch()) });
            return;
        }
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let hands = start.start.hands.clone();
        // The agent epoch AgentDO issued for this start; never the sandbox's.
        let epoch = start.start.agent_epoch();
        let secrets = vec![start.start.oauth_token.expose().to_owned()];
        let agent = Agent::new(
            id.clone(),
            start.start.role,
            epoch,
            PathBuf::from(&start.config_dir),
            hands,
            None,
            secrets,
            rt.current_gen(),
            cmd_tx,
            out_tx,
        );
        let deadline = Instant::now() + DYING_WAIT;
        loop {
            match rt.register(agent.clone()) {
                Ok(()) => break,
                Err(existing) if existing.conn_gen != agent.conn_gen && Instant::now() < deadline => {
                    // A brain from an earlier nestd connection: it was fenced when that
                    // connection dropped and is on its way out.
                    existing.kill_now(ExitReason::Fenced);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(existing) if existing.is_stopping() && Instant::now() < deadline => {
                    // A brain told to stop is never adopted: this start replaces it, so it ends now
                    // and the new brain registers once it is gone.
                    existing.kill_now(ExitReason::Stopped);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(existing) => {
                    // AgentDO started this brain again (it lost sight of it): the live brain keeps
                    // running, takes the new hands and adopts the newer agent epoch, which
                    // re-handshakes its session channel.
                    tracing::warn!(agent = %id, "agent_start for a brain that is already running; updating its hands and epoch only");
                    existing.set_hands(start.start.hands.clone());
                    existing.adopt_epoch(start.start.agent_epoch());
                    rt.report(RunnerEvent::Error {
                        agent: Some(id),
                        error: ErrorBody { code: "already_running".into(), message: "brain already running".into(), retryable: false },
                    });
                    return;
                }
            }
        }
        if let Err(e) = run(rt.clone(), agent.clone(), start, cmd_rx, out_rx).await {
            let reason = agent.kill_reason().unwrap_or(ExitReason::Crashed);
            tracing::error!(agent = %id, "agent failed to start: {e:#}");
            if reason == ExitReason::Crashed {
                rt.report_for(
                    &agent,
                    RunnerEvent::Error {
                        agent: Some(id.clone()),
                        error: ErrorBody { code: "agent_start_failed".into(), message: format!("{e:#}"), retryable: true },
                    },
                );
            }
            agent.send_out(Outbound::Close);
            rt.deregister(&agent);
            rt.report_for(&agent, RunnerEvent::AgentExited { agent: id, code: None, signal: None, reason, epoch: Some(agent.epoch()) });
        }
    });
}

/// Run one startup step with a deadline; a kill/stop cancels it.
async fn step<T>(cancel: &CancellationToken, what: &str, limit: Duration, f: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    tokio::select! {
        r = tokio::time::timeout(limit, f) => r.map_err(|_| anyhow::anyhow!("{what} timed out after {}s", limit.as_secs()))?,
        _ = cancel.cancelled() => anyhow::bail!("cancelled during {what}"),
    }
}

/// Where the session file for `uuid` lives (`claude::transcript_path` for the configured cwd;
/// production: `paths::EMPTY_CWD`). The runner rebases on the `SessionStart` hook's
/// `transcript_path` if it differs.
pub fn transcript_path(config_dir: &Path, cwd: &Path, uuid: &str) -> PathBuf {
    PathBuf::from(claude::transcript_path(&config_dir.to_string_lossy(), &cwd.to_string_lossy(), uuid))
}

/// Socket and binary paths from the runner config, as the protocol builders take them.
fn sockets(rt: &Runtime) -> nest_protocol::host::paths::RunnerSockets {
    nest_protocol::host::paths::RunnerSockets {
        hook_dgram: rt.cfg.hook_dgram.to_string_lossy().into_owned(),
        hook_sock: rt.cfg.hook_sock.to_string_lossy().into_owned(),
        mcp_sock: rt.cfg.mcp_sock.to_string_lossy().into_owned(),
        nest_bin: rt.cfg.nest_bin.to_string_lossy().into_owned(),
    }
}

/// Write the prompt and MCP config into the agent's config dir.
pub fn prepare_config_dir(rt: &Runtime, s: &AgentStart) -> anyhow::Result<()> {
    let dir = Path::new(&s.config_dir);
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(claude::PROMPT_FILE), claude::prompt_text(&s.start.launch))?;
    let cfg = claude::mcp_config(&s.start.agent, &sockets(rt));
    std::fs::write(dir.join(claude::MCP_CONFIG_FILE), serde_json::to_vec_pretty(&cfg)?)?;
    Ok(())
}

/// The complete, explicitly built environment (nothing inherited).
pub fn process_env(rt: &Runtime, s: &AgentStart) -> Vec<(String, String)> {
    claude::env(&s.start.agent, &s.config_dir, s.start.oauth_token.expose(), &sockets(rt))
}

/// Rebuild the session file from Worker-signed segment URLs unless the local copy is complete.
pub async fn materialize(resume: &SessionResume, path: &Path) -> anyhow::Result<()> {
    if std::fs::metadata(path).map(|m| m.len() == resume.total_bytes).unwrap_or(false) {
        return Ok(());
    }
    let mut buf: Vec<u8> = Vec::with_capacity(resume.total_bytes as usize);
    let client = reqwest::Client::new();
    for SegmentRef { offset, len, base, url } in &resume.segments {
        let bytes = client.get(url).send().await?.error_for_status()?.bytes().await?;
        anyhow::ensure!(bytes.len() as u64 == *len, "segment at {offset}: expected {len} bytes, got {}", bytes.len());
        if *base {
            anyhow::ensure!(*offset == 0, "base segment must start at 0");
            buf.clear();
        }
        anyhow::ensure!(*offset == buf.len() as u64, "segment gap at {offset} (have {})", buf.len());
        buf.extend_from_slice(&bytes);
    }
    anyhow::ensure!(buf.len() as u64 == resume.total_bytes, "rebuilt {} bytes, expected {}", buf.len(), resume.total_bytes);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("jsonl.part");
    std::fs::write(&tmp, &buf)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// `claude auth status` with the agent's environment → `authMethod` (anything else on failure).
pub async fn auth_method(rt: &Runtime, env: &[(String, String)]) -> String {
    let out = Command::new(&rt.cfg.claude_bin)
        .args(["auth", "status"])
        .env_clear()
        .envs(env.iter().cloned())
        .current_dir(&rt.cfg.cwd)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => serde_json::from_slice::<serde_json::Value>(&o.stdout)
            .ok()
            .and_then(|v| v.get("authMethod").and_then(|m| m.as_str()).map(String::from))
            .unwrap_or_else(|| "unknown".into()),
        Ok(o) => format!("error: auth status exited with {}", o.status),
        Err(e) => format!("error: {e}"),
    }
}

async fn claude_version(rt: &Runtime, env: &[(String, String)]) -> String {
    let out = Command::new(&rt.cfg.claude_bin)
        .arg("--version")
        .env_clear()
        .envs(env.iter().cloned())
        .current_dir(&rt.cfg.cwd)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().next().map(String::from))
        .unwrap_or_else(|| "unknown".into())
}

/// What a (re)spawn of Claude Code needs.
#[derive(Clone)]
struct Launch {
    launch: LaunchConfig,
    config_dir: String,
    env: Vec<(String, String)>,
}

async fn run(
    rt: Arc<Runtime>,
    agent: Arc<Agent>,
    s: AgentStart,
    cmd_rx: mpsc::UnboundedReceiver<AgentCmd>,
    out_rx: mpsc::UnboundedReceiver<Outbound>,
) -> anyhow::Result<()> {
    let cancel = agent.cancel.clone();
    let config_dir = PathBuf::from(&s.config_dir);
    prepare_config_dir(&rt, &s)?;

    // Session: new (we pick the UUID) or resume (rebuild the file first).
    let (args_session, session_id, transcript) = match &s.start.resume {
        Some(r) => {
            let uuid = claude::claude_uuid(&r.session).ok_or_else(|| anyhow::anyhow!("bad session id {}", r.session))?;
            let path = transcript_path(&config_dir, &rt.cfg.cwd, uuid);
            step(&cancel, "session rebuild", MATERIALIZE_TIMEOUT, materialize(r, &path)).await?;
            let sa = SessionArgs::Resume { path: path.to_string_lossy().into_owned(), fork: r.fork };
            (sa, (!r.fork).then(|| r.session.clone()), path)
        }
        None => {
            let uuid = uuid::Uuid::new_v4().to_string();
            let path = transcript_path(&config_dir, &rt.cfg.cwd, &uuid);
            (SessionArgs::New { uuid: uuid.clone() }, Some(claude::session_id(&uuid)), path)
        }
    };
    {
        let mut inner = agent.inner.lock().unwrap();
        inner.session = session_id.clone();
        inner.transcript = Some(transcript.clone());
    }
    // Hands: ask AgentDO where the sandbox is while the slow steps run (the request waits for
    // the session channel), so the SessionStart hook and the first tool call find the target.
    crate::hands::prefetch_target(agent.clone());

    let launch = Launch { launch: s.start.launch.clone(), config_dir: s.config_dir.clone(), env: process_env(&rt, &s) };

    // Auth, part 1: `claude auth status` must say oauth_token before anything runs.
    let auth = step(&cancel, "claude auth status", AUTH_TIMEOUT, async { Ok(auth_method(&rt, &launch.env).await) }).await?;
    if auth != "oauth_token" {
        rt.report_for(&agent, RunnerEvent::AuthCheck { agent: agent.id.clone(), auth_method: auth, api_key_source: "unknown".into(), ok: false });
        rt.deregister(&agent);
        rt.report_for(&agent, RunnerEvent::AgentExited { agent: agent.id.clone(), code: None, signal: None, reason: ExitReason::AuthFailed, epoch: Some(agent.epoch()) });
        return Ok(());
    }
    let version = step(&cancel, "claude --version", VERSION_TIMEOUT, async { Ok(claude_version(&rt, &launch.env).await) }).await?;
    if cancel.is_cancelled() {
        anyhow::bail!("cancelled before spawning Claude Code");
    }

    let proc = spawn_claude(&rt, &agent, &launch, &args_session)?;
    let opened = session::spawn(rt.clone(), agent.clone(), s.start.session_ws_url.clone(), transcript, session_id.clone(), out_rx);
    agent.emit(AgentEventBody::StateChanged { state: AgentState::Starting, detail: None });
    {
        let (rt, agent) = (rt.clone(), agent.clone());
        let session = session_id.clone().unwrap_or_else(|| SessionId("ses_pending".into()));
        let timeout = rt.cfg.session_open_timeout;
        let pid = proc.pid;
        tokio::spawn(async move {
            let _ = tokio::time::timeout(timeout, opened).await;
            let capabilities = agent.inner.lock().unwrap().capabilities.clone();
            rt.report_for(&agent, RunnerEvent::AgentStarted { agent: agent.id.clone(), pid, session, claude_version: version, capabilities });
        });
    }

    Actor {
        rt: rt.clone(),
        agent: agent.clone(),
        launch,
        pid: proc.pid,
        stdin: proc.stdin,
        auth_method: auth,
        auth_reported: false,
        outstanding: 0,
        tally: stream::TurnTally::default(),
        settle_deadline: None,
        idle_deadline: None,
        interrupt: None,
        exit_reason: None,
        stash: Vec::new(),
        req_n: 0,
    }
    .run(cmd_rx)
    .await;
    Ok(())
}

/// A running Claude Code process as the actor sees it.
struct Proc {
    pid: u32,
    stdin: StdinWriter,
}

fn spawn_claude(rt: &Runtime, agent: &Arc<Agent>, launch: &Launch, session: &SessionArgs) -> anyhow::Result<Proc> {
    let args = claude::args(&launch.launch, &launch.config_dir, session);
    let mut child = Command::new(&rt.cfg.claude_bin)
        .args(&args)
        .env_clear()
        .envs(launch.env.iter().cloned())
        .current_dir(&rt.cfg.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let pid = child.id().unwrap_or(0);
    agent.pid.store(pid, Ordering::SeqCst);
    let stdin = StdinWriter::new(child.stdin.take(), agent.id.to_string());
    let pump = pump_output(agent, &mut child);
    wait_exit(agent, child, pid, pump);
    if agent.cancel.is_cancelled() {
        // A kill raced the spawn: make sure this process dies too.
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
    }
    Ok(Proc { pid, stdin })
}

fn pump_output(agent: &Arc<Agent>, child: &mut Child) -> Option<JoinHandle<()>> {
    if let Some(err) = child.stderr.take() {
        let id = agent.id.clone();
        tokio::spawn(async move {
            let mut lines = framing::lines(err);
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(agent = %id, "claude stderr: {l}");
            }
        });
    }
    let out = child.stdout.take()?;
    let a = agent.clone();
    Some(tokio::spawn(async move {
        let mut lines = framing::lines(out);
        while let Ok(Some(l)) = lines.next_line().await {
            a.command(AgentCmd::Line(l));
        }
    }))
}

/// Report the exit only after the last stdout lines were queued (so final `result`s aren't lost).
fn wait_exit(agent: &Arc<Agent>, mut child: Child, pid: u32, pump: Option<JoinHandle<()>>) {
    let a = agent.clone();
    tokio::spawn(async move {
        use std::os::unix::process::ExitStatusExt;
        let st = child.wait().await;
        if let Some(p) = pump {
            let _ = tokio::time::timeout(Duration::from_secs(2), p).await;
        }
        let (code, signal) = match st {
            Ok(s) => (s.code(), s.signal()),
            Err(_) => (None, None),
        };
        a.command(AgentCmd::Exited { pid, code, signal });
    });
}

/// Claude Code's stdin, written by its own task: the actor never awaits a write, so kills and
/// fences are handled even when Claude Code isn't draining stdin.
struct StdinWriter {
    tx: Option<mpsc::Sender<Vec<u8>>>,
    task: Option<JoinHandle<()>>,
}

impl StdinWriter {
    fn new(stdin: Option<ChildStdin>, agent: String) -> Self {
        let Some(mut stdin) = stdin else { return Self { tx: None, task: None } };
        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(STDIN_QUEUE);
        let task = tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if let Err(e) = stdin.write_all(&line).await {
                    tracing::warn!(agent, "stdin write: {e}");
                    return;
                }
                let _ = stdin.flush().await;
            }
            // Sender dropped: everything queued is written; dropping stdin sends EOF.
        });
        Self { tx: Some(tx), task: Some(task) }
    }

    fn is_open(&self) -> bool {
        self.tx.as_ref().is_some_and(|t| !t.is_closed())
    }

    fn send(&self, msg: &StreamIn) -> Result<(), String> {
        let Some(tx) = &self.tx else { return Err("stdin is closed".into()) };
        let mut line = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
        line.push(b'\n');
        tx.try_send(line).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => "stdin queue is full (Claude Code isn't reading)".to_string(),
            mpsc::error::TrySendError::Closed(_) => "stdin is closed".to_string(),
        })
    }

    /// Finish queued writes, then EOF.
    fn close(&mut self) {
        self.tx = None;
    }

    /// Drop stdin now (kill).
    fn abort(&mut self) {
        self.tx = None;
        if let Some(t) = self.task.take() {
            t.abort();
        }
    }
}

enum InterruptStage {
    /// Control request sent; SIGINT at the deadline.
    Requested(Instant),
    /// SIGINT sent; SIGKILL at the deadline.
    Signalled(Instant),
}

struct Actor {
    rt: Arc<Runtime>,
    agent: Arc<Agent>,
    launch: Launch,
    pid: u32,
    stdin: StdinWriter,
    auth_method: String,
    auth_reported: bool,
    /// User messages written to stdin and not yet answered by a `result`.
    outstanding: u32,
    /// The current turn's `result`s, reported as one `turn_completed` when it ends.
    tally: stream::TurnTally,
    settle_deadline: Option<Instant>,
    idle_deadline: Option<Instant>,
    interrupt: Option<InterruptStage>,
    exit_reason: Option<ExitReason>,
    /// Turns/inbox messages that arrived after stdin was closed for idleness: replayed into a
    /// `--resume`d Claude Code once the current one has exited.
    stash: Vec<AgentCmd>,
    req_n: u64,
}

impl Actor {
    fn turn_active(&self) -> bool {
        self.outstanding > 0
    }

    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<AgentCmd>) {
        let mut spool_tick = tokio::time::interval(self.rt.cfg.spool_interval);
        loop {
            let deadline = self.next_deadline();
            tokio::select! {
                c = cmds.recv() => {
                    let Some(c) = c else { break };
                    if let AgentCmd::Exited { pid, code, signal } = c {
                        if self.on_exit(pid, code, signal) {
                            break;
                        }
                        continue;
                    }
                    self.handle(c);
                }
                _ = sleep_until(deadline) => self.on_deadline(),
                _ = spool_tick.tick() => crate::hooks::drain_spool(&self.agent),
            }
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        let i = match self.interrupt {
            Some(InterruptStage::Requested(t)) | Some(InterruptStage::Signalled(t)) => Some(t),
            None => None,
        };
        [i, self.idle_deadline, self.settle_deadline].into_iter().flatten().min()
    }

    fn handle(&mut self, c: AgentCmd) {
        match c {
            AgentCmd::RunTurn { turn, input } => {
                if !self.stdin.is_open() {
                    return self.deferred(AgentCmd::RunTurn { turn, input });
                }
                {
                    let mut inner = self.agent.inner.lock().unwrap();
                    inner.turn = Some(turn.clone());
                    inner.stop_continuations = 0;
                }
                self.agent.emit(AgentEventBody::TurnStarted { input_kind: input.kind });
                self.agent.emit(AgentEventBody::StateChanged { state: AgentState::Working, detail: None });
                match self.stdin.send(&StreamIn::user_text(&input.text)) {
                    Ok(()) => self.wrote_user_message(),
                    Err(e) => self.agent.emit_with_turn(
                        AgentEventBody::Error { error: ErrorBody { code: "stdin".into(), message: e, retryable: true } },
                        Some(turn),
                    ),
                }
            }
            AgentCmd::Inbox(m) => {
                if !self.stdin.is_open() {
                    return self.deferred(AgentCmd::Inbox(m));
                }
                if m.interrupt {
                    self.request_interrupt();
                }
                let text = format!("[message from {}]\n{}", m.from, m.text);
                let starts_turn = !self.turn_active();
                match self.stdin.send(&StreamIn::user_text(&text)) {
                    Ok(()) => {
                        self.agent.inner.lock().unwrap().delivered.insert(m.id.clone());
                        self.agent.emit(AgentEventBody::InboxDelivered { message: m.id.clone() });
                        if starts_turn {
                            self.agent.emit(AgentEventBody::TurnStarted { input_kind: TurnInputKind::Inbox });
                        }
                        self.wrote_user_message();
                    }
                    Err(e) => self.agent.emit(AgentEventBody::Error { error: ErrorBody { code: "stdin".into(), message: e, retryable: true } }),
                }
            }
            AgentCmd::Interrupt => self.request_interrupt(),
            AgentCmd::Stop(StopMode::Graceful) => {
                self.exit_reason.get_or_insert(ExitReason::Stopped);
                self.stdin.close();
            }
            AgentCmd::Stop(StopMode::Kill) => self.kill(ExitReason::Stopped),
            AgentCmd::Kill(reason) => self.kill(reason),
            AgentCmd::StaleEpoch => self.kill(ExitReason::Fenced),
            AgentCmd::Line(l) => self.on_line(&l),
            AgentCmd::Exited { .. } => unreachable!("handled in run"),
        }
    }

    fn wrote_user_message(&mut self) {
        self.outstanding += 1;
        self.idle_deadline = None;
        self.settle_deadline = None;
    }

    /// Input that can't be written because stdin is closed.
    fn deferred(&mut self, c: AgentCmd) {
        let reason = self.exit_reason.or(self.agent.kill_reason());
        if reason == Some(ExitReason::Idle) && !self.agent.cancel.is_cancelled() {
            // Closed for idleness: Claude Code is exiting; resume it and replay on exit.
            self.stash.push(c);
            return;
        }
        let why = reason.map(|r| r.as_str()).unwrap_or("stopping");
        let error = |what: &str| ErrorBody {
            code: "agent_stopping".into(),
            message: format!("{what} not delivered: the brain is {why}"),
            retryable: true,
        };
        match c {
            AgentCmd::RunTurn { turn, .. } => self.agent.emit_with_turn(AgentEventBody::Error { error: error("turn") }, Some(turn)),
            AgentCmd::Inbox(m) => self.agent.emit(AgentEventBody::Error { error: error(&format!("inbox message {}", m.id)) }),
            _ => {}
        }
    }

    fn request_interrupt(&mut self) {
        if !self.turn_active() || self.interrupt.is_some() {
            return;
        }
        let grace = self.rt.cfg.interrupt_grace;
        let supports = self.agent.inner.lock().unwrap().capabilities.iter().any(|c| c == CAP_INTERRUPT);
        if supports {
            self.req_n += 1;
            let req = StreamIn::ControlRequest {
                request_id: format!("int_{}", self.req_n),
                request: claude::ControlRequest::Interrupt { cancel_queued: false },
            };
            if self.stdin.send(&req).is_ok() {
                self.interrupt = Some(InterruptStage::Requested(Instant::now() + grace));
                return;
            }
        }
        self.sigint();
        self.agent.cancel_hands();
        self.interrupt = Some(InterruptStage::Signalled(Instant::now() + grace));
    }

    fn on_deadline(&mut self) {
        let now = Instant::now();
        match self.interrupt {
            Some(InterruptStage::Requested(t)) if t <= now => {
                tracing::warn!(agent = %self.agent.id, "interrupt not honored; SIGINT");
                self.sigint();
                self.agent.cancel_hands();
                self.interrupt = Some(InterruptStage::Signalled(now + self.rt.cfg.interrupt_grace));
                return;
            }
            Some(InterruptStage::Signalled(t)) if t <= now => {
                tracing::warn!(agent = %self.agent.id, "still running after SIGINT; killing");
                self.kill(ExitReason::Crashed);
                self.interrupt = None;
                return;
            }
            _ => {}
        }
        if self.settle_deadline.is_some_and(|t| t <= now) {
            // Queued messages were answered by the last `result`.
            self.settle_deadline = None;
            self.turn_finished();
        }
        if self.idle_deadline.is_some_and(|t| t <= now) {
            self.idle_deadline = None;
            if !self.turn_active() && self.agent.pending_inbox().is_empty() {
                // Idle exit: close stdin; Claude Code finishes and exits.
                self.exit_reason.get_or_insert(ExitReason::Idle);
                self.stdin.close();
            }
        }
    }

    /// The runner's turn is over (no message outstanding, or the settle passed): the one place
    /// that reports `turn_completed` and `idle`, stamped with the turn that just ended.
    fn turn_finished(&mut self) {
        self.outstanding = 0;
        self.interrupt = None;
        let turn = self.agent.inner.lock().unwrap().turn.take();
        for body in self.tally.finish() {
            self.agent.emit_with_turn(body, turn.clone());
        }
        self.idle_deadline = Some(Instant::now() + self.rt.cfg.idle_grace);
    }

    fn on_line(&mut self, line: &str) {
        let out: StreamOut = match serde_json::from_str(line) {
            Ok(o) => o,
            Err(e) => {
                tracing::debug!(agent = %self.agent.id, "unparsed stream line ({e}): {line}");
                return;
            }
        };
        if !matches!(out, StreamOut::Result(_)) {
            // Activity after a `result`: more queued input is being worked on.
            self.settle_deadline = None;
        }
        if let StreamOut::System(SystemMessage::Init { session_id, api_key_source, capabilities, tools, .. }) = &out {
            tracing::info!(agent = %self.agent.id, ?tools, "system/init");
            if let Some(bad) = tools.iter().find(|t| !tool_allowed(t)) {
                tracing::error!(agent = %self.agent.id, tool = %bad, "Claude Code reports a built-in tool outside the host-safe allowlist; killing");
                self.agent.emit(AgentEventBody::Error {
                    error: ErrorBody { code: "forbidden_tool".into(), message: format!("built-in tool {bad} is enabled"), retryable: false },
                });
                self.kill(ExitReason::Crashed);
                return;
            }
            let new_session = claude::session_id(session_id);
            let (changed, caps_changed) = {
                let mut inner = self.agent.inner.lock().unwrap();
                let caps_changed = inner.capabilities != *capabilities;
                inner.capabilities = capabilities.clone();
                let changed = inner.session.as_ref() != Some(&new_session);
                inner.session = Some(new_session.clone());
                (changed, caps_changed)
            };
            if caps_changed {
                // `system/init` may arrive only after the first user message, i.e. after
                // `agent_started` went out with empty capabilities.
                self.agent.emit(AgentEventBody::Capabilities { capabilities: capabilities.clone() });
                self.rt.report_for(&self.agent, RunnerEvent::AgentCapabilities { agent: self.agent.id.clone(), capabilities: capabilities.clone() });
            }
            if changed {
                // Fork: Claude Code minted a new session id and file.
                let path = transcript_path(&self.agent.config_dir, &self.rt.cfg.cwd, session_id);
                self.agent.send_out(Outbound::SetSession(new_session));
                self.agent.set_transcript(path);
            }
            if !self.auth_reported {
                self.auth_reported = true;
                let ok = api_key_source == "none";
                self.rt.report_for(
                    &self.agent,
                    RunnerEvent::AuthCheck {
                        agent: self.agent.id.clone(),
                        auth_method: self.auth_method.clone(),
                        api_key_source: api_key_source.clone(),
                        ok,
                    },
                );
                if !ok {
                    self.kill(ExitReason::AuthFailed);
                    return;
                }
            }
        }
        let turn = self.agent.inner.lock().unwrap().turn.clone();
        for body in stream::events_for(&out) {
            self.agent.emit_with_turn(body, turn.clone());
        }
        match out {
            StreamOut::Result(r) => {
                // One user message answered; the turn ends (and is reported) only when none
                // is left, so an inbox message written mid-turn stays inside the turn.
                self.tally.add(&r);
                self.outstanding = self.outstanding.saturating_sub(1);
                if self.outstanding == 0 {
                    self.turn_finished();
                } else {
                    self.interrupt = None;
                    self.settle_deadline = Some(Instant::now() + SETTLE);
                }
            }
            StreamOut::ControlResponse { response } => tracing::debug!(agent = %self.agent.id, ?response, "control response"),
            _ => {}
        }
    }

    /// SIGINT to Claude Code itself only: its process group also holds `nest mcp` and hooks,
    /// which must survive an interrupt.
    fn sigint(&self) {
        if self.pid > 0 {
            let _ = kill(Pid::from_raw(self.pid as i32), Signal::SIGINT);
        }
    }

    fn kill(&mut self, reason: ExitReason) {
        self.exit_reason.get_or_insert(reason);
        self.stdin.abort();
        self.agent.cancel_hands();
        if self.pid > 0 {
            let _ = killpg(Pid::from_raw(self.pid as i32), Signal::SIGKILL);
        }
    }

    /// Returns true when the actor is done.
    fn on_exit(&mut self, pid: u32, code: Option<i32>, signal: Option<i32>) -> bool {
        if pid != self.pid {
            return false; // a previous process of this agent
        }
        let reason = self.exit_reason.or(self.agent.kill_reason()).unwrap_or(ExitReason::Crashed);
        tracing::info!(agent = %self.agent.id, ?code, ?signal, reason = reason.as_str(), "claude exited");
        if reason == ExitReason::Idle && !self.stash.is_empty() && !self.agent.cancel.is_cancelled() {
            match self.respawn() {
                Ok(()) => {
                    for c in std::mem::take(&mut self.stash) {
                        self.handle(c);
                    }
                    return false;
                }
                Err(e) => {
                    tracing::error!(agent = %self.agent.id, "resume after idle exit failed: {e:#}");
                    for c in std::mem::take(&mut self.stash) {
                        self.exit_reason = Some(ExitReason::Crashed);
                        self.deferred(c);
                    }
                }
            }
        }
        self.agent.cancel_hands();
        self.agent.emit(AgentEventBody::StateChanged { state: AgentState::Detached, detail: Some(reason.as_str().into()) });
        self.agent.send_out(Outbound::Close);
        self.rt.deregister(&self.agent);
        self.rt.report_for(&self.agent, RunnerEvent::AgentExited { agent: self.agent.id.clone(), code, signal, reason, epoch: Some(self.agent.epoch()) });
        true
    }

    /// Start Claude Code again on the same session (`--resume <current session file>`).
    fn respawn(&mut self) -> anyhow::Result<()> {
        let path = self
            .agent
            .inner
            .lock()
            .unwrap()
            .transcript
            .clone()
            .ok_or_else(|| anyhow::anyhow!("no session file to resume"))?;
        let session = SessionArgs::Resume { path: path.to_string_lossy().into_owned(), fork: false };
        let proc = spawn_claude(&self.rt, &self.agent, &self.launch, &session)?;
        tracing::info!(agent = %self.agent.id, pid = proc.pid, "resumed Claude Code for queued input");
        self.pid = proc.pid;
        self.stdin = proc.stdin;
        self.exit_reason = None;
        self.outstanding = 0;
        self.tally = stream::TurnTally::default();
        self.interrupt = None;
        self.idle_deadline = None;
        self.settle_deadline = None;
        self.auth_reported = false;
        Ok(())
    }
}

async fn sleep_until(t: Option<Instant>) {
    match t {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serve `bodies[i]` at `/i` over plain HTTP/1.1.
    async fn http_server(bodies: Vec<&'static [u8]>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let bodies = bodies.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = s.read(&mut buf).await.unwrap();
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let i: usize = req.split_whitespace().nth(1).unwrap().trim_start_matches('/').parse().unwrap();
                    let b = bodies[i];
                    let head = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", b.len());
                    s.write_all(head.as_bytes()).await.unwrap();
                    s.write_all(b).await.unwrap();
                });
            }
        });
        base
    }

    #[tokio::test]
    async fn materialize_applies_base_resets_and_skips_complete_files() {
        let base = http_server(vec![b"old-1\n", b"new-1\n", b"new-2\n"]).await;
        let seg = |i: usize, offset: u64, len: u64, base_flag: bool| SegmentRef { offset, len, base: base_flag, url: format!("{base}/{i}") };
        let resume = SessionResume {
            session: claude::session_id("u-1"),
            segments: vec![seg(0, 0, 6, false), seg(1, 0, 6, true), seg(2, 6, 6, false)],
            total_bytes: 12,
            fork: false,
        };
        let dir = std::env::temp_dir().join(format!("nest-mat-{}", uuid::Uuid::new_v4().simple()));
        let path = dir.join("p/u-1.jsonl");
        materialize(&resume, &path).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new-1\nnew-2\n");
        // A complete local file isn't downloaded again (URLs would 404 the server's index).
        let mut bad = resume.clone();
        bad.segments = vec![SegmentRef { offset: 0, len: 12, base: false, url: "http://127.0.0.1:1/nope".into() }];
        materialize(&bad, &path).await.unwrap();
        // A gap is an error.
        std::fs::remove_file(&path).unwrap();
        let gap = SessionResume { segments: vec![seg(2, 6, 6, false)], total_bytes: 6, ..resume };
        assert!(materialize(&gap, &path).await.is_err());
    }

    /// An actor with no process behind it: stdin lines land in the returned receiver, events
    /// in the outbound one. `pid` 0 makes signals and kills no-ops.
    fn bare_actor() -> (Actor, mpsc::Receiver<Vec<u8>>, mpsc::UnboundedReceiver<Outbound>) {
        use nest_protocol::control::SystemPrompt;
        use nest_protocol::model::{AgentId, AgentRole};
        let rt = Runtime::new(crate::Config::default());
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_t".into()), AgentRole::Worker, nest_protocol::model::Epoch(1), std::env::temp_dir(), None, None, vec![], 0, cmd_tx, out_tx);
        let (stdin_tx, stdin_rx) = mpsc::channel(STDIN_QUEUE);
        let launch = LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: String::new() } };
        let actor = Actor {
            rt,
            agent,
            launch: Launch { launch, config_dir: String::new(), env: vec![] },
            pid: 0,
            stdin: StdinWriter { tx: Some(stdin_tx), task: None },
            auth_method: "oauth_token".into(),
            auth_reported: true,
            outstanding: 0,
            tally: stream::TurnTally::default(),
            settle_deadline: None,
            idle_deadline: None,
            interrupt: None,
            exit_reason: None,
            stash: Vec::new(),
            req_n: 0,
        };
        (actor, stdin_rx, out_rx)
    }

    fn result_line(stop: &str) -> String {
        serde_json::json!({"type": "result", "subtype": "success", "is_error": false, "num_turns": 1, "duration_ms": 1,
            "total_cost_usd": 0.01, "usage": {"input_tokens": 3, "output_tokens": 1}, "stop_reason": stop, "result": "x",
            "session_id": "s"})
        .to_string()
    }

    /// `(turn, kind)` for every event sent so far.
    fn drained(out: &mut mpsc::UnboundedReceiver<Outbound>) -> Vec<(Option<String>, &'static str)> {
        let mut v = Vec::new();
        while let Ok(o) = out.try_recv() {
            if let Outbound::Event(e) = o {
                let kind = match e.body {
                    AgentEventBody::TurnStarted { .. } => "turn_started",
                    AgentEventBody::TurnCompleted { .. } => "turn_completed",
                    AgentEventBody::StateChanged { state: AgentState::Idle, .. } => "idle",
                    AgentEventBody::StateChanged { state: AgentState::Working, .. } => "working",
                    AgentEventBody::InboxDelivered { .. } => "inbox_delivered",
                    _ => "other",
                };
                v.push((e.turn.map(|t| t.0), kind));
            }
        }
        v
    }

    #[tokio::test]
    async fn an_inbox_message_delivered_mid_turn_stays_inside_the_turn() {
        use nest_protocol::control::{InboxMessage, TurnInput};
        use nest_protocol::model::{MessageId, TurnId};
        let (mut actor, _stdin, mut out) = bare_actor();
        actor.handle(AgentCmd::RunTurn { turn: TurnId("trn_1".into()), input: TurnInput { kind: TurnInputKind::User, text: "go".into() } });
        actor.handle(AgentCmd::Inbox(InboxMessage { id: MessageId("msg_1".into()), from: "user".into(), text: "also".into(), interrupt: false, ts_ms: 0 }));
        let t1 = Some("trn_1".to_string());
        assert_eq!(drained(&mut out), [(t1.clone(), "turn_started"), (t1.clone(), "working"), (t1.clone(), "inbox_delivered")]);

        // The first result answers the turn's own message; the inbox message is still outstanding.
        actor.handle(AgentCmd::Line(result_line("end_turn")));
        assert_eq!(drained(&mut out), [], "no turn_completed or idle while a message is outstanding");
        assert_eq!(actor.agent.inner.lock().unwrap().turn.as_ref().map(|t| t.0.as_str()), Some("trn_1"));

        // The second result ends the turn: reported once, with the turn's id.
        actor.handle(AgentCmd::Line(result_line("end_turn")));
        assert_eq!(drained(&mut out), [(t1.clone(), "turn_completed"), (t1, "idle")]);
        assert!(actor.agent.inner.lock().unwrap().turn.is_none());

        // The next turn is its own.
        actor.handle(AgentCmd::RunTurn { turn: TurnId("trn_2".into()), input: TurnInput { kind: TurnInputKind::User, text: "next".into() } });
        actor.handle(AgentCmd::Line(result_line("end_turn")));
        let t2 = Some("trn_2".to_string());
        assert_eq!(drained(&mut out), [(t2.clone(), "turn_started"), (t2.clone(), "working"), (t2.clone(), "turn_completed"), (t2, "idle")]);
    }

    #[tokio::test]
    async fn a_result_that_leaves_messages_outstanding_ends_the_turn_after_the_settle() {
        use nest_protocol::control::{InboxMessage, TurnInput};
        use nest_protocol::model::{MessageId, TurnId};
        let (mut actor, _stdin, mut out) = bare_actor();
        actor.handle(AgentCmd::RunTurn { turn: TurnId("trn_1".into()), input: TurnInput { kind: TurnInputKind::User, text: "go".into() } });
        actor.handle(AgentCmd::Inbox(InboxMessage { id: MessageId("msg_1".into()), from: "user".into(), text: "also".into(), interrupt: false, ts_ms: 0 }));
        actor.handle(AgentCmd::Line(result_line("end_turn")));
        drained(&mut out);
        // Claude Code merged the inbox message into that answer: no second result comes.
        assert!(actor.settle_deadline.is_some());
        actor.settle_deadline = Some(Instant::now());
        actor.on_deadline();
        let t1 = Some("trn_1".to_string());
        assert_eq!(drained(&mut out), [(t1.clone(), "turn_completed"), (t1, "idle")]);
    }

    #[test]
    fn only_host_safe_built_ins_are_allowed() {
        // What the control plane's default worker launch names, and the observed init names.
        for t in ["TodoWrite", "Task", "Agent", "WebSearch", "WebFetch", "TaskCreate", "mcp__nest__Bash"] {
            assert!(tool_allowed(t), "{t}");
        }
        // Host-touching built-ins, and one Claude Code might add tomorrow.
        for t in ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "PowerShell", "Monitor", "SomeNewTool"] {
            assert!(!tool_allowed(t), "{t}");
        }
    }

    #[test]
    fn transcript_path_matches_protocol_builder_for_empty_cwd() {
        let p = transcript_path(Path::new("/var/lib/nest/agents/agt_x"), Path::new(nest_protocol::host::paths::EMPTY_CWD), "u-1");
        assert_eq!(p.to_string_lossy(), claude::transcript_path("/var/lib/nest/agents/agt_x", nest_protocol::host::paths::EMPTY_CWD, "u-1"));
    }
}
