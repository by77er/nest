//! Shared runner state: the agent registry and the per-agent handle used by the supervisor,
//! hook server, MCP bridge and session channel.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::control::{AgentCache, InboxMessage, ToolDef, ToolOutcome, TurnInput};
use nest_protocol::host::Secret;
use nest_protocol::host::mcp::ToolCallResult;
use nest_protocol::host::runner::{ExitReason, LocalHands, RunnerEvent, StopMode};
use nest_protocol::model::{
    AgentEvent, AgentEventBody, AgentId, AgentRole, CallId, Epoch, ErrorBody, HostId, MessageId, RequestId,
    SessionId, TimestampMs, TurnId,
};
use serde_json::Value;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::config::Config;

pub fn now_ms() -> TimestampMs {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Error code for a platform call whose outcome is unknown (timed out after it may have been
/// delivered).
pub use nest_protocol::model::error_codes::OUTCOME_UNKNOWN;

/// Process-wide state.
pub struct Runtime {
    pub cfg: Config,
    agents: Mutex<HashMap<AgentId, Arc<Agent>>>,
    /// Newest host token from nestd (memory only).
    pub host_token: watch::Sender<Option<Secret>>,
    pub host_id: Mutex<Option<HostId>>,
    /// Events to nestd, tagged with the nestd connection generation they belong to; the writer
    /// of connection N drops entries from older generations (brains killed when the previous
    /// connection was lost must not be reported to the new one, which already re-issued them).
    pub to_nestd: mpsc::UnboundedSender<(u64, RunnerEvent)>,
    pub to_nestd_rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<(u64, RunnerEvent)>>,
    /// Current nestd connection generation (incremented on every connect).
    pub conn_gen: AtomicU64,
    /// Host lease mirror (`valid_until_ms`); `None` until the first `lease_update`.
    pub lease: Mutex<Option<TimestampMs>>,
}

impl Runtime {
    pub fn new(cfg: Config) -> Arc<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            cfg,
            agents: Mutex::new(HashMap::new()),
            host_token: watch::channel(None).0,
            host_id: Mutex::new(None),
            to_nestd: tx,
            to_nestd_rx: tokio::sync::Mutex::new(rx),
            conn_gen: AtomicU64::new(0),
            lease: Mutex::new(None),
        })
    }

    pub fn agent(&self, id: &AgentId) -> Option<Arc<Agent>> {
        self.agents.lock().unwrap().get(id).cloned()
    }

    pub fn agents(&self) -> Vec<Arc<Agent>> {
        self.agents.lock().unwrap().values().cloned().collect()
    }

    /// Register (first thing a start does, before any slow step); returns the agent already
    /// registered under this id instead, if any.
    pub fn register(&self, a: Arc<Agent>) -> Result<(), Arc<Agent>> {
        let mut m = self.agents.lock().unwrap();
        if let Some(existing) = m.get(&a.id) {
            return Err(existing.clone());
        }
        m.insert(a.id.clone(), a);
        Ok(())
    }

    /// Remove `a` — only if it is still the registered instance (a duplicate start must never
    /// deregister the live brain).
    pub fn deregister(&self, a: &Arc<Agent>) {
        let mut m = self.agents.lock().unwrap();
        if m.get(&a.id).is_some_and(|cur| Arc::ptr_eq(cur, a)) {
            m.remove(&a.id);
        }
    }

    pub fn current_gen(&self) -> u64 {
        self.conn_gen.load(Ordering::SeqCst)
    }

    /// Report on the current nestd connection.
    pub fn report(&self, ev: RunnerEvent) {
        let _ = self.to_nestd.send((self.current_gen(), ev));
    }

    /// Report an agent's lifecycle event; dropped if the agent belongs to an older connection.
    pub fn report_for(&self, agent: &Agent, ev: RunnerEvent) {
        let _ = self.to_nestd.send((agent.conn_gen, ev));
    }

    /// Is the host lease mirror valid right now?
    pub fn lease_valid(&self) -> bool {
        self.lease.lock().unwrap().is_some_and(|v| now_ms() <= v)
    }

    /// Kill every brain (lease lapse, nestd gone, `fence` with an empty list).
    pub fn kill_all(&self, reason: ExitReason) {
        for a in self.agents() {
            a.kill_now(reason);
        }
    }

    /// The registered brain whose Claude Code process is `pid` or an ancestor of it (hooks and
    /// `nest mcp` are its descendants). Binds a socket peer to an agent without trusting the id
    /// it declares.
    pub fn agent_for_pid(&self, pid: i32) -> Option<Arc<Agent>> {
        let agents = self.agents();
        let mut cur = pid;
        for _ in 0..64 {
            if cur <= 1 {
                return None;
            }
            if let Some(a) = agents.iter().find(|a| a.pid.load(Ordering::SeqCst) as i32 == cur) {
                return Some(a.clone());
            }
            cur = parent_pid(cur)?;
        }
        None
    }

    pub fn host(&self) -> HostId {
        self.host_id.lock().unwrap().clone().unwrap_or_else(|| HostId("hst_unknown".into()))
    }
}

/// Parent pid from `/proc/<pid>/stat` (the field after the `)` that ends the command name).
fn parent_pid(pid: i32) -> Option<i32> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    s.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
}

/// Commands to an agent's lifecycle actor.
#[derive(Debug)]
pub enum AgentCmd {
    RunTurn { turn: TurnId, input: TurnInput },
    Inbox(InboxMessage),
    Interrupt,
    Stop(StopMode),
    Kill(ExitReason),
    /// One stdout line from Claude Code.
    Line(String),
    /// The process exited.
    Exited { pid: u32, code: Option<i32>, signal: Option<i32> },
    /// The session channel reported AgentDO rejected our epoch.
    StaleEpoch,
}

/// Messages from the agent to its session-channel task.
#[derive(Debug)]
pub enum Outbound {
    Event(AgentEvent),
    ToolCall { call: CallId, turn: Option<TurnId>, name: String, arguments: Value },
    ToolsListRequest(RequestId),
    /// Follow a different transcript file (SessionStart `transcript_path`, forks).
    SetTranscript(PathBuf),
    SetSession(SessionId),
    /// Re-handshake (epoch changed after a rebind).
    Reconnect,
    /// A platform tool call timed out: never (re)send it.
    AbandonCall(CallId),
    /// Flush and close.
    Close,
}

/// Mutable per-agent state shared with hooks and the MCP bridge.
#[derive(Debug, Default)]
pub struct AgentInner {
    pub hands: Option<LocalHands>,
    pub cache: Option<AgentCache>,
    /// Inbox messages already delivered (stdin or `Stop`).
    pub delivered: HashSet<MessageId>,
    pub stop_continuations: u32,
    pub turn: Option<TurnId>,
    pub tools: Vec<ToolDef>,
    pub session: Option<SessionId>,
    pub capabilities: Vec<String>,
    /// The session file currently tailed (follows `SessionStart` and forks); used to resume.
    pub transcript: Option<PathBuf>,
}

/// Handle to one agent.
pub struct Agent {
    pub id: AgentId,
    pub role: AgentRole,
    pub config_dir: PathBuf,
    /// nestd connection generation this brain was started under.
    pub conn_gen: u64,
    /// Claude Code's pid once spawned (0 before), for kills that must not wait on the actor and
    /// for binding hook/MCP peers to this agent.
    pub pid: AtomicU32,
    /// Cancelled by any kill/stop: aborts startup steps and tells the actor.
    pub cancel: CancellationToken,
    kill_reason: Mutex<Option<ExitReason>>,
    pub inner: Mutex<AgentInner>,
    epoch: AtomicU64,
    cmd: mpsc::UnboundedSender<AgentCmd>,
    out: mpsc::UnboundedSender<Outbound>,
    pub pending_calls: Mutex<HashMap<CallId, oneshot::Sender<ToolOutcome>>>,
    pub pending_lists: Mutex<HashMap<RequestId, oneshot::Sender<Vec<ToolDef>>>>,
    pub tools_changed: broadcast::Sender<()>,
    /// In-flight hands calls (bridge-scoped key → cancel), cancelled on hard interrupt.
    pub hands_inflight: Mutex<HashMap<String, oneshot::Sender<()>>>,
    event_seq: AtomicU64,
    call_n: AtomicU64,
    /// Values redacted from anything leaving the host (session segments).
    pub secrets: Vec<String>,
}

impl Agent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: AgentId,
        role: AgentRole,
        epoch: Epoch,
        config_dir: PathBuf,
        hands: Option<LocalHands>,
        session: Option<SessionId>,
        secrets: Vec<String>,
        conn_gen: u64,
        cmd: mpsc::UnboundedSender<AgentCmd>,
        out: mpsc::UnboundedSender<Outbound>,
    ) -> Arc<Self> {
        Arc::new(Self {
            id,
            role,
            config_dir,
            conn_gen,
            pid: AtomicU32::new(0),
            cancel: CancellationToken::new(),
            kill_reason: Mutex::new(None),
            inner: Mutex::new(AgentInner { hands, session, ..Default::default() }),
            epoch: AtomicU64::new(epoch.0),
            cmd,
            out,
            pending_calls: Mutex::new(HashMap::new()),
            pending_lists: Mutex::new(HashMap::new()),
            tools_changed: broadcast::channel(8).0,
            hands_inflight: Mutex::new(HashMap::new()),
            event_seq: AtomicU64::new(0),
            call_n: AtomicU64::new(0),
            secrets,
        })
    }

    pub fn epoch(&self) -> Epoch {
        Epoch(self.epoch.load(Ordering::SeqCst))
    }

    pub fn command(&self, c: AgentCmd) {
        let _ = self.cmd.send(c);
    }

    /// Kill now, without waiting on the actor: cancels startup, SIGKILLs the process group if
    /// Claude Code is running, and tells the actor (which reports the exit).
    pub fn kill_now(&self, reason: ExitReason) {
        self.kill_reason.lock().unwrap().get_or_insert(reason);
        self.cancel.cancel();
        let pid = self.pid.load(Ordering::SeqCst);
        if pid > 0 {
            let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
        }
        self.cancel_hands();
        self.command(AgentCmd::Kill(reason));
    }

    /// First kill reason recorded by [`Agent::kill_now`].
    pub fn kill_reason(&self) -> Option<ExitReason> {
        *self.kill_reason.lock().unwrap()
    }

    /// Follow a different session file (tailer + resume path).
    pub fn set_transcript(&self, p: PathBuf) {
        self.inner.lock().unwrap().transcript = Some(p.clone());
        self.send_out(Outbound::SetTranscript(p));
    }

    pub fn send_out(&self, o: Outbound) {
        let _ = self.out.send(o);
    }

    /// Emit one canonical event (stamped with seq, time, current turn).
    pub fn emit(&self, body: AgentEventBody) {
        let turn = self.inner.lock().unwrap().turn.clone();
        self.emit_with_turn(body, turn);
    }

    pub fn emit_with_turn(&self, body: AgentEventBody, turn: Option<TurnId>) {
        let seq = nest_protocol::model::Seq(self.event_seq.fetch_add(1, Ordering::SeqCst) + 1);
        self.send_out(Outbound::Event(AgentEvent { agent: self.id.clone(), epoch: self.epoch(), seq, ts_ms: now_ms(), turn, body }));
    }

    /// Rebind hands. A new epoch re-handshakes the session channel; MCP clients are told the
    /// tool list changed.
    pub fn bind(&self, hands: Option<LocalHands>) {
        let new_epoch = hands.as_ref().map(|h| h.epoch);
        self.inner.lock().unwrap().hands = hands;
        if let Some(e) = new_epoch
            && self.epoch.swap(e.0, Ordering::SeqCst) != e.0
        {
            self.send_out(Outbound::Reconnect);
        }
        let _ = self.tools_changed.send(());
    }

    /// Apply a cache update unless it's older than what we have.
    pub fn set_cache(&self, cache: AgentCache) {
        let mut inner = self.inner.lock().unwrap();
        if inner.cache.as_ref().is_some_and(|c| c.version >= cache.version) {
            return;
        }
        inner.cache = Some(cache);
    }

    /// `call = cal_<turn without '_'>-<n>`; outside a turn, a random stem.
    pub fn next_call_id(&self) -> CallId {
        let n = self.call_n.fetch_add(1, Ordering::SeqCst) + 1;
        let stem = match &self.inner.lock().unwrap().turn {
            Some(t) => t.0.replace('_', ""),
            None => format!("x{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
        };
        CallId(format!("cal_{stem}-{n}"))
    }

    /// Relay a platform tool call to AgentDO and wait for the outcome.
    pub async fn platform_call(&self, name: &str, arguments: Value, timeout: Duration) -> ToolCallResult {
        let call = self.next_call_id();
        let (tx, rx) = oneshot::channel();
        self.pending_calls.lock().unwrap().insert(call.clone(), tx);
        let turn = self.inner.lock().unwrap().turn.clone();
        self.send_out(Outbound::ToolCall { call: call.clone(), turn, name: name.into(), arguments });
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => ToolCallResult::from(&outcome),
            _ => {
                // Never let a late resend execute it after we've told the model it failed.
                self.pending_calls.lock().unwrap().remove(&call);
                self.send_out(Outbound::AbandonCall(call.clone()));
                let e = ErrorBody {
                    code: OUTCOME_UNKNOWN.into(),
                    message: format!(
                        "platform tool call {call} timed out; it may or may not have taken effect. Check before \
                         retrying anything with side effects."
                    ),
                    retryable: false,
                };
                ToolCallResult::from(&ToolOutcome::Error { error: e })
            }
        }
    }

    /// Escalate a tool call that matched no grant rule: emits `AgentEventBody::Escalation`,
    /// which AgentDO treats like an `ask` to the captain or user. Returns the request id quoted
    /// in the deny reason; the answer arrives as the agent's next turn input.
    pub fn escalate(&self, tool: &str, input: Value) -> CallId {
        let call = self.next_call_id();
        self.emit(AgentEventBody::Escalation { call: call.clone(), tool: tool.into(), input });
        call
    }

    /// Current platform tool list from AgentDO (falls back to the last one received).
    pub async fn platform_tools(&self, timeout: Duration) -> Vec<ToolDef> {
        let req = RequestId(format!("req_{}", uuid::Uuid::new_v4().simple()));
        let (tx, rx) = oneshot::channel();
        self.pending_lists.lock().unwrap().insert(req.clone(), tx);
        self.send_out(Outbound::ToolsListRequest(req.clone()));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(tools)) => tools,
            _ => {
                self.pending_lists.lock().unwrap().remove(&req);
                self.inner.lock().unwrap().tools.clone()
            }
        }
    }

    pub fn resolve_call(&self, call: &CallId, outcome: ToolOutcome) {
        if let Some(tx) = self.pending_calls.lock().unwrap().remove(call) {
            let _ = tx.send(outcome);
        }
    }

    pub fn resolve_tools(&self, req: &RequestId, tools: Vec<ToolDef>) {
        self.inner.lock().unwrap().tools = tools.clone();
        if let Some(tx) = self.pending_lists.lock().unwrap().remove(req) {
            let _ = tx.send(tools);
        }
    }

    /// Cancel every in-flight hands call (hard interrupt / kill).
    pub fn cancel_hands(&self) {
        for (_, tx) in self.hands_inflight.lock().unwrap().drain() {
            let _ = tx.send(());
        }
    }

    /// Undelivered inbox-mirror messages.
    pub fn pending_inbox(&self) -> Vec<InboxMessage> {
        let inner = self.inner.lock().unwrap();
        inner
            .cache
            .as_ref()
            .map(|c| c.inbox.iter().filter(|m| !inner.delivered.contains(&m.id)).cloned().collect())
            .unwrap_or_default()
    }
}
