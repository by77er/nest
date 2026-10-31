//! One brain: prepare the config dir, verify auth, spawn Claude Code, drive stream-json, and
//! report lifecycle to nestd.
//!
//! Lifecycle rules (see `docs/interfaces/host-internal/nestd-runner/`):
//! - A start registers the agent **first**, so `fence`/`agent_stop`/lease lapse reach it during
//!   the slow startup steps (each has a timeout and is cancellable); a duplicate start never
//!   touches the live brain.
//! - Kills never wait on the actor or on Claude Code's stdin ([`Agent::kill_now`]); stdin is
//!   written by its own task.
//! - A turn arriving after stdin was closed for idleness restarts Claude Code with `--resume` and
//!   runs there; after a stop/kill it is reported as an error event, never silently dropped.
//! - Turn decisions live in [`crate::brain`]; the actor here applies them.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use nest_protocol::control::{SegmentRef, SessionResume};
use nest_protocol::host::claude::{self, SessionArgs, StreamIn, StreamOut, SystemMessage};
use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerEvent};
use nest_protocol::control::LaunchConfig;
use nest_protocol::model::{AgentEventBody, AgentState, ErrorBody, SessionId};
use nix::sys::signal::{Signal, kill, killpg};
use nix::unistd::Pid;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::brain::{Brain, Effect, Input, Timers};
use crate::framing;
use crate::runtime::{Agent, AgentCmd, Outbound, Refused, Runtime};
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
/// How often a start waiting for the previous brain (being killed) to go away looks again.
const DYING_POLL: Duration = Duration::from_millis(100);
/// Pending stdin messages per brain before a write is refused.
const STDIN_QUEUE: usize = 64;

/// Start an agent in the background. Errors are reported to nestd.
pub fn start(rt: Arc<Runtime>, start: AgentStart) {
    // Taken on arrival, before the task runs: a fence of every brain after this drops the start.
    let fence_gen = rt.fence_gen();
    tokio::spawn(async move {
        let id = start.start.agent.clone();
        // The agent epoch AgentDO issued for this start; never the sandbox's. Every control plane
        // since #30 sends it; a start without one would run under no epoch AgentDO accepts.
        let Some(epoch) = start.start.epoch else {
            let error = ErrorBody { code: "invalid_message".into(), message: "agent_start without an agent epoch".into(), retryable: false };
            rt.report(RunnerEvent::Error { agent: Some(id.clone()), error });
            refuse_superseding(&rt, &id, nest_protocol::model::Epoch(0), ExitReason::Crashed).await;
            return;
        };
        if let Some(bad) = start.start.launch.builtin_tools.iter().find(|t| !HOST_SAFE_BUILTINS.contains(&t.as_str())) {
            let msg = format!("refusing to start: built-in tool {bad} is not on the runner's host-safe allowlist");
            tracing::error!(agent = %id, "{msg}");
            rt.report(RunnerEvent::Error { agent: Some(id.clone()), error: ErrorBody { code: "forbidden_tool".into(), message: msg, retryable: false } });
            refuse_superseding(&rt, &id, epoch, ExitReason::Crashed).await;
            return;
        }
        if !rt.lease_valid() {
            rt.report(RunnerEvent::Error {
                agent: Some(id.clone()),
                error: ErrorBody { code: "no_lease".into(), message: "no valid host lease; refusing to start a brain".into(), retryable: true },
            });
            refuse_superseding(&rt, &id, epoch, ExitReason::Fenced).await;
            return;
        }
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let hands = start.start.hands.clone();
        let secrets = vec![start.start.oauth_token.expose().to_owned()];
        let agent = Agent::new(
            id.clone(),
            epoch,
            PathBuf::from(&start.config_dir),
            hands,
            secrets,
            rt.current_gen(),
            cmd_tx,
            out_tx,
        );
        // An exit this runner reports at an agent epoch means no brain of the agent at or below it
        // runs here any more (AgentDO releases the brain on it): a start that never runs reports
        // its exit only once any older brain has gone.
        let older_gone = |rt: &Runtime| rt.agent(&id).is_none_or(|a| a.epoch > epoch);
        loop {
            match rt.register(agent.clone(), fence_gen) {
                Ok(()) => break,
                Err(Refused::Killed) => {
                    // A kill for this epoch (or a later one) overtook the start: it never runs. The
                    // kill also ended any older brain; its exit is reported once that one is gone.
                    tracing::warn!(agent = %id, epoch = epoch.0, "agent_start below a kill's epoch: refused");
                    while !older_gone(&rt) {
                        tokio::time::sleep(DYING_POLL).await;
                    }
                    rt.exited(&agent, ExitReason::Fenced, (None, None));
                    return;
                }
                Err(Refused::Running(existing)) if existing.epoch == epoch => {
                    // The same start again (a duplicate): a no-op; the brain runs on (N22).
                    tracing::warn!(agent = %id, epoch = epoch.0, "duplicate agent_start for the registered brain: ignored");
                    return;
                }
                Err(Refused::Running(existing)) if existing.epoch > epoch => {
                    // A newer brain is registered: this start is stale (N18). It never runs, never
                    // ends the newer brain, and its exit says so at its own epoch.
                    tracing::warn!(agent = %id, epoch = epoch.0, running = existing.epoch.0, "agent_start older than the registered brain: refused");
                    rt.exited(&agent, ExitReason::Fenced, (None, None));
                    return;
                }
                Err(Refused::Running(existing)) => {
                    // AgentDO starts a brain only once the previous one is released, so an older
                    // brain still registered here is one on its way out (of an earlier nestd
                    // connection, fenced when it dropped, or killed): never adopted, never run
                    // beside. It is ended, and this start registers once it is gone.
                    if existing.conn_gen == agent.conn_gen && !existing.is_stopping() {
                        tracing::warn!(agent = %id, epoch = epoch.0, "agent_start while a brain of this agent is registered; ending it first");
                    }
                    existing.stopping.store(true, Ordering::SeqCst);
                    existing.kill_now(if existing.conn_gen != agent.conn_gen { ExitReason::Fenced } else { ExitReason::Stopped });
                    tokio::time::sleep(DYING_POLL).await;
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
            rt.exited(&agent, reason, (None, None));
        }
    });
}

/// Refuse a start before it registers (a forbidden built-in, no lease). It supersedes any older brain
/// of the agent here, which is ended under the start's epoch (its tombstone); the refusal's exit is
/// reported only once that brain has gone, since an exit at an epoch means nothing of the agent at
/// or below it runs here (A4).
async fn refuse_superseding(rt: &Arc<Runtime>, id: &nest_protocol::model::AgentId, epoch: nest_protocol::model::Epoch, reason: ExitReason) {
    if let Some(old) = rt.tombstone(id, epoch) {
        old.stopping.store(true, Ordering::SeqCst);
        old.kill_now(ExitReason::Stopped);
    }
    while rt.agent(id).is_some_and(|a| a.epoch <= epoch) {
        tokio::time::sleep(DYING_POLL).await;
    }
    rt.report(RunnerEvent::AgentExited { agent: id.clone(), code: None, signal: None, reason, epoch: Some(epoch) });
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

/// Claude Code with exactly `env` (nothing inherited), in the configured cwd.
fn claude_cmd(rt: &Runtime, env: &[(String, String)]) -> Command {
    let mut c = Command::new(&rt.cfg.claude_bin);
    c.env_clear().envs(env.iter().cloned()).current_dir(&rt.cfg.cwd).kill_on_drop(true);
    c
}

/// `claude auth status` with the agent's environment → `authMethod` (anything else on failure).
pub async fn auth_method(rt: &Runtime, env: &[(String, String)]) -> String {
    let out = claude_cmd(rt, env).args(["auth", "status"]).stdin(Stdio::null()).output().await;
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
    let out = claude_cmd(rt, env).arg("--version").stdin(Stdio::null()).output().await;
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
        rt.exited(&agent, ExitReason::AuthFailed, (None, None));
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
        // The epoch this start registered under: nestd marks that start.
        let epoch = agent.epoch;
        tokio::spawn(async move {
            let _ = tokio::time::timeout(timeout, opened).await;
            let capabilities = agent.inner.lock().unwrap().capabilities.clone();
            rt.report_for(&agent, RunnerEvent::AgentStarted { agent: agent.id.clone(), pid, session, claude_version: version, capabilities, epoch: Some(epoch) });
        });
    }

    Actor::new(rt.clone(), agent.clone(), launch, proc, auth).run(cmd_rx).await;
    Ok(())
}

/// A running Claude Code process as the actor sees it.
struct Proc {
    pid: u32,
    stdin: StdinWriter,
}

fn spawn_claude(rt: &Runtime, agent: &Arc<Agent>, launch: &Launch, session: &SessionArgs) -> anyhow::Result<Proc> {
    let args = claude::args(&launch.launch, &launch.config_dir, session);
    let mut child = claude_cmd(rt, &launch.env)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
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

    #[cfg(test)]
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

/// The shell around one [`Brain`]: it turns commands and stdout lines into brain inputs, and the
/// brain's effects into stdin writes, signals, events and nestd reports.
struct Actor {
    rt: Arc<Runtime>,
    agent: Arc<Agent>,
    launch: Launch,
    pid: u32,
    stdin: StdinWriter,
    auth_method: String,
    auth_reported: bool,
    brain: Brain,
    /// The last exit's code and signal, for the report.
    exit_status: (Option<i32>, Option<i32>),
    req_n: u64,
}

impl Actor {
    fn new(rt: Arc<Runtime>, agent: Arc<Agent>, launch: Launch, proc: Proc, auth_method: String) -> Self {
        let timers = Timers { idle_grace: rt.cfg.idle_grace, interrupt_grace: rt.cfg.interrupt_grace };
        Actor {
            rt,
            agent,
            launch,
            pid: proc.pid,
            stdin: proc.stdin,
            auth_method,
            auth_reported: false,
            brain: Brain::new(timers, Instant::now()),
            exit_status: (None, None),
            req_n: 0,
        }
    }

    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<AgentCmd>) {
        let mut spool_tick = tokio::time::interval(self.rt.cfg.spool_interval);
        loop {
            let deadline = self.brain.next_deadline();
            let done = tokio::select! {
                c = cmds.recv() => match c {
                    Some(c) => self.handle(c),
                    None => true,
                },
                _ = sleep_until(deadline) => self.step(Input::Tick),
                _ = spool_tick.tick() => {
                    crate::hooks::drain_spool(&self.agent);
                    false
                }
            };
            if done {
                break;
            }
        }
    }

    /// Returns true when the actor is done.
    fn handle(&mut self, c: AgentCmd) -> bool {
        let input = match c {
            AgentCmd::RunTurn { turn, input } => Input::RunTurn { turn, input },
            AgentCmd::Inbox(m) => Input::Inbox { interrupt: m.interrupt },
            AgentCmd::Interrupt { turn } => Input::Interrupt { turn },
            AgentCmd::StopHook { blocked } => Input::StopHook { blocked },
            AgentCmd::Stop(mode) => Input::Stop(mode),
            AgentCmd::Kill(reason) => Input::Kill(reason),
            AgentCmd::StaleEpoch => Input::Kill(ExitReason::Fenced),
            AgentCmd::Line(l) => return self.on_line(&l),
            AgentCmd::Exited { pid, code, signal } => {
                if pid != self.pid {
                    return false; // a previous process of this agent
                }
                tracing::info!(agent = %self.agent.id, ?code, ?signal, "claude exited");
                self.exit_status = (code, signal);
                Input::Exited { killed: self.agent.kill_reason() }
            }
        };
        self.step(input)
    }

    /// Feed the brain, mirror its turn into the shared state hooks and tool calls read, then apply
    /// its effects. Returns true when the actor is done.
    fn step(&mut self, input: Input) -> bool {
        let effects = self.brain.step(input, Instant::now());
        {
            let mut inner = self.agent.inner.lock().unwrap();
            inner.turn = self.brain.turn().cloned();
            inner.mirror.set_open(self.brain.takes_inbox());
        }
        let mut done = false;
        for e in effects {
            done |= self.apply(e);
        }
        done
    }

    fn apply(&mut self, e: Effect) -> bool {
        match e {
            Effect::WriteTurn { turn, text } => {
                if let Err(e) = self.stdin.send(&StreamIn::user_text(&text)) {
                    let error = ErrorBody { code: "stdin".into(), message: e, retryable: true };
                    self.agent.emit_with_turn(AgentEventBody::Error { error }, Some(turn));
                }
            }
            Effect::WriteInterrupt => {
                self.req_n += 1;
                let req = StreamIn::ControlRequest {
                    request_id: format!("int_{}", self.req_n),
                    request: claude::ControlRequest::Interrupt { cancel_queued: false },
                };
                // Not written (stdin gone): the deadline sends SIGINT.
                let _ = self.stdin.send(&req);
            }
            Effect::CloseStdin => self.stdin.close(),
            Effect::AbortStdin => self.stdin.abort(),
            // Claude Code itself only: its process group also holds `nest mcp` and hooks, which
            // must survive an interrupt.
            Effect::Sigint if self.pid > 0 => {
                let _ = kill(Pid::from_raw(self.pid as i32), Signal::SIGINT);
            }
            Effect::KillGroup if self.pid > 0 => {
                let _ = killpg(Pid::from_raw(self.pid as i32), Signal::SIGKILL);
            }
            Effect::Sigint | Effect::KillGroup => {}
            Effect::CancelHands => self.agent.cancel_hands(),
            Effect::Emit { body, turn } => self.agent.emit_with_turn(body, turn),
            Effect::Respawn => {
                let ok = match self.respawn() {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::error!(agent = %self.agent.id, "resume after idle exit failed: {e:#}");
                        false
                    }
                };
                return self.step(Input::Respawned { ok });
            }
            Effect::Exit(reason) => {
                tracing::info!(agent = %self.agent.id, reason = reason.as_str(), "brain exited");
                self.agent.cancel_hands();
                self.agent.emit(AgentEventBody::StateChanged { state: AgentState::Detached, detail: Some(reason.as_str().into()) });
                self.agent.send_out(Outbound::Close);
                self.rt.exited(&self.agent, reason, self.exit_status);
                return true;
            }
        }
        false
    }

    /// One stdout line: checks on `system/init`, events for everything, and a `result` to the brain.
    fn on_line(&mut self, line: &str) -> bool {
        let out: StreamOut = match serde_json::from_str(line) {
            Ok(o) => o,
            Err(e) => {
                tracing::debug!(agent = %self.agent.id, "unparsed stream line ({e}): {line}");
                return false;
            }
        };
        if let StreamOut::System(SystemMessage::Init { session_id, api_key_source, capabilities, tools, .. }) = &out {
            tracing::info!(agent = %self.agent.id, ?tools, "system/init");
            if let Some(bad) = tools.iter().find(|t| !tool_allowed(t)) {
                tracing::error!(agent = %self.agent.id, tool = %bad, "Claude Code reports a built-in tool outside the host-safe allowlist; killing");
                self.agent.emit(AgentEventBody::Error {
                    error: ErrorBody { code: "forbidden_tool".into(), message: format!("built-in tool {bad} is enabled"), retryable: false },
                });
                return self.step(Input::Kill(ExitReason::Crashed));
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
            self.step(Input::InterruptSupported(capabilities.iter().any(|c| c == CAP_INTERRUPT)));
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
                    return self.step(Input::Kill(ExitReason::AuthFailed));
                }
            }
        }
        let turn = self.brain.turn().cloned();
        for body in stream::events_for(&out) {
            self.agent.emit_with_turn(body, turn.clone());
        }
        match out {
            StreamOut::Result(r) => self.step(Input::Result(r)),
            StreamOut::ControlResponse { response } => {
                tracing::debug!(agent = %self.agent.id, ?response, "control response");
                false
            }
            _ => false,
        }
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
    use serde_json::json;

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

    /// An actor with no process behind it, its agent registered (hooks find it): stdin lines land
    /// in the returned receiver, events in the outbound one, commands the hooks send in the
    /// command one. `pid` 0 makes signals and kills no-ops.
    struct Bare {
        actor: Actor,
        stdin: mpsc::Receiver<Vec<u8>>,
        out: mpsc::UnboundedReceiver<Outbound>,
        cmds: mpsc::UnboundedReceiver<AgentCmd>,
    }

    fn bare_actor() -> Bare {
        use nest_protocol::control::SystemPrompt;
        use nest_protocol::model::AgentId;
        let rt = Runtime::new(crate::Config::default());
        let (cmd_tx, cmds) = mpsc::unbounded_channel();
        let (out_tx, out) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_t".into()), nest_protocol::model::Epoch(1), std::env::temp_dir(), None, vec![], 0, cmd_tx, out_tx);
        assert!(rt.register(agent.clone(), rt.fence_gen()).is_ok());
        let (stdin_tx, stdin) = mpsc::channel(STDIN_QUEUE);
        let launch = LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: String::new() } };
        let proc = Proc { pid: 0, stdin: StdinWriter { tx: Some(stdin_tx), task: None } };
        let mut actor = Actor::new(rt, agent, Launch { launch, config_dir: String::new(), env: vec![] }, proc, "oauth_token".into());
        actor.auth_reported = true;
        Bare { actor, stdin, out, cmds }
    }

    impl Bare {
        /// Run a hook as Claude Code would, then hand the actor what the hook told it.
        async fn hook(&mut self, input: serde_json::Value) -> nest_protocol::host::hook::HookOutput {
            let req = nest_protocol::host::hook::HookDecisionRequest { v: 1, agent: self.actor.agent.id.clone(), input };
            let answer = crate::hooks::decide(&self.actor.rt, &req).await;
            let output = answer.output.clone();
            answer.settle(&self.actor.agent, true);
            while let Ok(c) = self.cmds.try_recv() {
                self.actor.handle(c);
            }
            output
        }

        /// The user messages written to stdin so far.
        fn written(&mut self) -> Vec<String> {
            let mut v = Vec::new();
            while let Ok(line) = self.stdin.try_recv() {
                let m: serde_json::Value = serde_json::from_slice(&line).unwrap();
                v.push(m["message"]["content"][0]["text"].as_str().unwrap_or_default().to_string());
            }
            v
        }

        /// `(turn, kind)` for every turn, state and inbox event sent so far.
        fn events(&mut self) -> Vec<(Option<String>, &'static str)> {
            let mut v = Vec::new();
            while let Ok(o) = self.out.try_recv() {
                if let Outbound::Event(e) = o {
                    let kind = match e.body {
                        AgentEventBody::TurnStarted { .. } => "turn_started",
                        AgentEventBody::TurnCompleted { .. } => "turn_completed",
                        AgentEventBody::StateChanged { state: AgentState::Idle, .. } => "idle",
                        AgentEventBody::StateChanged { state: AgentState::Working, .. } => "working",
                        AgentEventBody::InboxDelivered { .. } => "inbox_delivered",
                        _ => continue,
                    };
                    v.push((e.turn.map(|t| t.0), kind));
                }
            }
            v
        }
    }

    fn result_line() -> String {
        serde_json::json!({"type": "result", "subtype": "success", "is_error": false, "num_turns": 1, "duration_ms": 1,
            "total_cost_usd": 0.01, "usage": {"input_tokens": 3, "output_tokens": 1}, "stop_reason": "end_turn", "result": "x",
            "session_id": "s"})
        .to_string()
    }

    fn msg(id: &str) -> nest_protocol::control::InboxMessage {
        nest_protocol::control::InboxMessage { id: nest_protocol::model::MessageId(id.into()), from: "user".into(), text: format!("also {id}"), interrupt: false, ts_ms: 0 }
    }

    fn cache(inbox: Vec<nest_protocol::control::InboxMessage>, version: u64) -> nest_protocol::control::AgentCache {
        nest_protocol::control::AgentCache { version, rules: vec![], inbox, max_stop_continuations: 5 }
    }

    fn run_turn(id: &str) -> AgentCmd {
        use nest_protocol::control::TurnInput;
        use nest_protocol::model::{TurnId, TurnInputKind};
        AgentCmd::RunTurn { turn: TurnId(id.into()), input: TurnInput { kind: TurnInputKind::User, text: format!("go {id}") } }
    }

    /// R3 and R4: stdin carries exactly one user message per turn. An inbox message never goes to
    /// stdin, with no turn running (it would start a turn AgentDO never scheduled) or mid-turn
    /// (the Stop hook may hand it out too); the hooks hand each one out once.
    #[tokio::test]
    async fn stdin_carries_only_the_turns_message_and_hooks_deliver_the_inbox_once() {
        let mut b = bare_actor();
        b.actor.agent.set_cache(cache(vec![msg("m1")], 1));
        b.actor.handle(AgentCmd::Inbox(msg("m1")));
        assert_eq!((b.written(), b.events()), (vec![], vec![]), "no turn: nothing written, no turn started");
        let o = b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": false})).await;
        assert_eq!(o.decision, None, "no turn takes inbox");
        assert_eq!(b.events(), [(None, "idle")]);

        b.actor.handle(run_turn("t1"));
        b.actor.handle(AgentCmd::Inbox(msg("m1")));
        assert_eq!(b.written(), ["go t1"]);
        let t1 = Some("t1".to_string());
        assert_eq!(b.events(), [(t1.clone(), "turn_started"), (t1.clone(), "working")]);
        // A Stop that blocks keeps the turn going: no idle.
        let o = b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": false})).await;
        assert!(o.reason.unwrap().contains("also m1"));
        assert_eq!(b.events(), [(t1.clone(), "inbox_delivered")]);
        // Delivered once: the next stop of the chain lets the turn end, and its result ends it.
        assert_eq!(b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": true})).await.decision, None);
        b.actor.handle(AgentCmd::Line(result_line()));
        assert_eq!(b.events(), [(t1.clone(), "idle"), (t1.clone(), "turn_completed"), (t1, "idle")]);
        assert!(b.written().is_empty());
    }

    /// The mid-turn path: a message that arrives during a turn reaches the model at the next tool
    /// boundary, as `PostToolUse` context, and is confirmed with the turn's id.
    #[tokio::test]
    async fn an_inbox_message_reaches_the_model_at_the_next_tool_boundary() {
        let mut b = bare_actor();
        b.actor.handle(run_turn("t1"));
        b.events();
        let t1 = Some("t1".to_string());
        let o = b.hook(json!({"hook_event_name": "PostToolUse", "tool_name": "mcp__nest__Bash"})).await;
        assert_eq!(o, Default::default(), "nothing pending");
        assert_eq!(b.events(), [(t1.clone(), "working")]);
        b.actor.agent.set_cache(cache(vec![msg("m1")], 1));
        let o = b.hook(json!({"hook_event_name": "PostToolUse", "tool_name": "mcp__nest__Bash"})).await;
        match o.hook_specific_output {
            Some(nest_protocol::host::hook::HookSpecificOutput::PostToolUse { additional_context: Some(c) }) => assert!(c.contains("also m1"), "{c}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(b.events(), [(t1.clone(), "working"), (t1.clone(), "inbox_delivered")]);
        assert_eq!(b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": false})).await.decision, None, "already delivered");
        assert_eq!(b.events(), [(t1, "idle")]);
    }

    /// A subagent's PostToolUse hands out nothing: its context would reach the subagent, not the
    /// main loop. The message waits for the main loop's next tool boundary or its Stop.
    #[tokio::test]
    async fn a_subagents_tool_boundary_hands_out_nothing() {
        let mut b = bare_actor();
        b.actor.handle(run_turn("t1"));
        b.actor.agent.set_cache(cache(vec![msg("m1")], 1));
        b.events();
        let sub = json!({"hook_event_name": "PostToolUse", "tool_name": "mcp__nest__Bash", "agent_id": "a1b2", "agent_type": "general-purpose"});
        assert_eq!(b.hook(sub).await, Default::default());
        let t1 = Some("t1".to_string());
        assert_eq!(b.events(), [(t1.clone(), "working")]);
        assert!(b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": false})).await.decision.is_some(), "still pending at Stop");
    }

    /// A `result` after the Stop hook blocked is taken for an intermediate one (Claude Code 2.1.316
    /// emits none): the turn ends only at the `result` after the stop it allowed,
    /// so a second `result` of one turn can never complete the next.
    #[tokio::test]
    async fn a_result_after_a_blocked_stop_does_not_end_the_turn() {
        let mut b = bare_actor();
        b.actor.handle(run_turn("t1"));
        b.actor.agent.set_cache(cache(vec![msg("m1")], 1));
        assert!(b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": false})).await.decision.is_some());
        b.events();
        b.actor.handle(AgentCmd::Line(result_line()));
        assert_eq!(b.events(), [], "the continuation is owed");
        assert!(b.hook(json!({"hook_event_name": "Stop", "stop_hook_active": true})).await.decision.is_none());
        b.actor.handle(AgentCmd::Line(result_line()));
        let t1 = Some("t1".to_string());
        assert_eq!(b.events(), [(t1.clone(), "idle"), (t1.clone(), "turn_completed"), (t1, "idle")]);
    }

    /// R8: the idle exit is not held off by mirrored inbox messages (a message no turn took is
    /// AgentDO's to queue again). Before, a non-empty mirror disarmed the idle clock for good.
    #[tokio::test]
    async fn the_idle_exit_ignores_the_mirror() {
        let mut b = bare_actor();
        b.actor.brain = Brain::new(Timers { idle_grace: Duration::ZERO, interrupt_grace: Duration::ZERO }, Instant::now());
        b.actor.agent.set_cache(cache(vec![msg("m1")], 1));
        b.actor.step(Input::Tick);
        assert!(!b.actor.stdin.is_open(), "stdin closed for idleness");
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
