//! Shared runner state: the agent registry and the per-agent handle used by the supervisor,
//! hook server, MCP bridge and session channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::control::{AgentCache, HandsBinding, HandsOutcome, InboxMessage, ToolDef, ToolOutcome, TurnInput};
use nest_protocol::gateway::HandsTarget;
use nest_protocol::host::Secret;
use nest_protocol::host::mcp::ToolCallResult;
use nest_protocol::host::runner::{ExitReason, RunnerEvent, StopMode};
use nest_protocol::model::error_codes::OUTCOME_UNKNOWN;
use nest_protocol::model::{
    AgentEvent, AgentEventBody, AgentId, CallId, Epoch, ErrorBody, HostId, RequestId,
    SessionId, TimestampMs, TurnId,
};
use serde_json::Value;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::mirror::InboxMirror;

pub fn now_ms() -> TimestampMs {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}


/// Process-wide state.
pub struct Runtime {
    pub cfg: Config,
    /// Registered brains and the kill tombstones, under one lock: a registration and a kill for
    /// the same agent are ordered, so a kill can't slip between a start's spawn and its registration.
    agents: Mutex<Registry>,
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
            agents: Mutex::new(Registry::default()),
            host_token: watch::channel(None).0,
            host_id: Mutex::new(None),
            to_nestd: tx,
            to_nestd_rx: tokio::sync::Mutex::new(rx),
            conn_gen: AtomicU64::new(0),
            lease: Mutex::new(None),
        })
    }

    pub fn agent(&self, id: &AgentId) -> Option<Arc<Agent>> {
        self.agents.lock().unwrap().agents.get(id).cloned()
    }

    pub fn agents(&self) -> Vec<Arc<Agent>> {
        self.agents.lock().unwrap().agents.values().cloned().collect()
    }

    /// Register (first thing a start does, before any slow step). Refused when a kill at or above
    /// the start's agent epoch arrived first (its tombstone), or when another brain is registered
    /// under this id.
    pub fn register(&self, a: Arc<Agent>, fence_gen: u64) -> Result<(), Refused> {
        let mut r = self.agents.lock().unwrap();
        // A fence of every brain (lease lapse, nestd gone) since this start arrived: it never runs.
        if r.fence_gen != fence_gen || r.tombstones.get(&a.id).is_some_and(|k| *k >= a.epoch.0) {
            return Err(Refused::Killed);
        }
        if let Some(existing) = r.agents.get(&a.id) {
            return Err(Refused::Running(existing.clone()));
        }
        r.agents.insert(a.id.clone(), a);
        Ok(())
    }

    /// `a` exited or never ran: deregister it if it is still the registered instance (a refused
    /// or duplicate start never deregisters another brain), then report the exit at its epoch.
    pub fn exited(&self, a: &Arc<Agent>, reason: ExitReason, (code, signal): (Option<i32>, Option<i32>)) {
        {
            let mut r = self.agents.lock().unwrap();
            if r.agents.get(&a.id).is_some_and(|cur| Arc::ptr_eq(cur, a)) {
                r.agents.remove(&a.id);
            }
        }
        self.report_for(a, RunnerEvent::AgentExited { agent: a.id.clone(), code, signal, reason, epoch: Some(a.epoch) });
    }

    /// A kill for `agent` at agent epoch `epoch` (`agent_stop{kill, epoch}`): raise its tombstone,
    /// so no start at or below it registers from now on, and return the registered brain if it
    /// runs at or below it (the caller kills it). A newer brain is left alone.
    pub fn tombstone(&self, agent: &AgentId, epoch: Epoch) -> Option<Arc<Agent>> {
        let mut r = self.agents.lock().unwrap();
        let k = r.tombstones.entry(agent.clone()).or_insert(epoch.0);
        *k = (*k).max(epoch.0);
        r.agents.get(agent).filter(|a| a.epoch <= epoch).cloned()
    }

    /// Whether a kill at or above `epoch` arrived for `agent`.
    pub fn tombstoned(&self, agent: &AgentId, epoch: Epoch) -> bool {
        self.agents.lock().unwrap().tombstones.get(agent).is_some_and(|k| *k >= epoch.0)
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

    /// The fence generation now: a start takes it when it arrives and registers only if no fence
    /// of every brain came in between ([`Runtime::register`]).
    pub fn fence_gen(&self) -> u64 {
        self.agents.lock().unwrap().fence_gen
    }

    /// Kill every brain (lease lapse, nestd gone, `fence` with an empty list), and every start that
    /// arrived before this and hasn't registered yet (it never will).
    pub fn kill_all(&self, reason: ExitReason) {
        let agents: Vec<Arc<Agent>> = {
            let mut r = self.agents.lock().unwrap();
            r.fence_gen += 1;
            r.agents.values().cloned().collect()
        };
        for a in agents {
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

/// The brains this runner runs, and per agent the highest agent epoch a kill named (kept for the
/// process's life: one number per agent).
#[derive(Default)]
struct Registry {
    agents: HashMap<AgentId, Arc<Agent>>,
    tombstones: HashMap<AgentId, u64>,
    /// Bumped by every fence of all brains (under this lock, so it orders against registrations).
    fence_gen: u64,
}

/// Why [`Runtime::register`] refused a brain.
pub enum Refused {
    /// A kill at or above its agent epoch, or a fence of every brain, arrived first: it must never run.
    Killed,
    /// Another brain is registered under the id.
    Running(Arc<Agent>),
}

/// Removes a `hands_resolve` request from the pending map when its waiter goes away.
struct PendingResolve<'a> {
    agent: &'a Agent,
    req: RequestId,
}

impl Drop for PendingResolve<'_> {
    fn drop(&mut self) {
        self.agent.pending_resolves.lock().unwrap().remove(&self.req);
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
    /// AgentDO's `interrupt`, for `turn` (`None`: whatever runs).
    Interrupt { turn: Option<TurnId> },
    /// The `Stop` hook answered, `blocked` = the turn continues with inbox messages. Sent before
    /// the answer is written, so it reaches the actor before the `result` that follows it.
    StopHook { blocked: bool },
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
    /// Ask AgentDO where the agent's hands are now (`hands_resolve`); answered through
    /// [`Agent::resolve_hands`].
    HandsResolve(RequestId),
    /// Follow a different transcript file (SessionStart `transcript_path`, forks).
    SetTranscript(PathBuf),
    SetSession(SessionId),
    /// Re-handshake: AgentDO refused something (most likely a segment gap), so resend from what it has.
    Reconnect,
    /// A platform tool call timed out: never (re)send it.
    AbandonCall(CallId),
    /// Flush and close.
    Close,
}

/// AgentDO did not answer `hands_resolve` in time (or the session channel was down).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolveTimeout;

/// Mutable per-agent state shared with hooks and the MCP bridge.
#[derive(Debug, Default)]
pub struct AgentInner {
    /// The gateway target for those hands, fetched from AgentDO (`hands_resolve`) and dropped
    /// whenever a gateway refuses it, so the next call asks again.
    pub target: Option<HandsTarget>,
    /// Bumped on every [`Agent::set_hands_target`], so a call that saw an old target drops only
    /// that one ([`Agent::drop_target_if`]) and never a fresher target another call stored.
    pub target_gen: u64,
    pub cache: Option<AgentCache>,
    /// Which mirrored inbox messages the hooks handed out (with `cache.inbox`, under this lock).
    pub mirror: InboxMirror,
    /// The turn running now; written only by the actor, from its brain.
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
    /// Fixed for the brain's life: a later start for this agent ends this brain, never adopts it.
    pub epoch: Epoch,
    /// The sandbox this agent's hands act in (from `agent_start`); `None` = no hands. Its epoch
    /// comes from each target's binding claims, so a sandbox move changes nothing here.
    pub hands: Option<HandsBinding>,
    pub config_dir: PathBuf,
    /// nestd connection generation this brain was started under.
    pub conn_gen: u64,
    /// Claude Code's pid once spawned (0 before), for kills that must not wait on the actor and
    /// for binding hook/MCP peers to this agent.
    pub pid: AtomicU32,
    /// Cancelled by any kill/stop: aborts startup steps and tells the actor.
    pub cancel: CancellationToken,
    /// An `agent_stop` reached this brain: it is on its way out.
    pub stopping: std::sync::atomic::AtomicBool,
    kill_reason: Mutex<Option<ExitReason>>,
    pub inner: Mutex<AgentInner>,
    cmd: mpsc::UnboundedSender<AgentCmd>,
    out: mpsc::UnboundedSender<Outbound>,
    pub pending_calls: Mutex<HashMap<CallId, oneshot::Sender<ToolOutcome>>>,
    pub pending_lists: Mutex<HashMap<RequestId, oneshot::Sender<Vec<ToolDef>>>>,
    pub pending_resolves: Mutex<HashMap<RequestId, oneshot::Sender<HandsOutcome>>>,
    /// Held while one caller resolves the target, so N parallel first calls send one
    /// `hands_resolve` and the rest find the cached target.
    pub resolve_gate: tokio::sync::Mutex<()>,
    /// Parent of every hands call's cancel token: a hard interrupt or kill cancels it and starts
    /// a fresh one for later calls.
    hands_cancel: Mutex<CancellationToken>,
    event_seq: AtomicU64,
    call_n: AtomicU64,
    /// Values redacted from anything leaving the host (session segments).
    pub secrets: Vec<String>,
}

impl Agent {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: AgentId,
        epoch: Epoch,
        config_dir: PathBuf,
        hands: Option<HandsBinding>,
        secrets: Vec<String>,
        conn_gen: u64,
        cmd: mpsc::UnboundedSender<AgentCmd>,
        out: mpsc::UnboundedSender<Outbound>,
    ) -> Arc<Self> {
        Arc::new(Self {
            id,
            epoch,
            hands,
            config_dir,
            conn_gen,
            pid: AtomicU32::new(0),
            cancel: CancellationToken::new(),
            stopping: std::sync::atomic::AtomicBool::new(false),
            kill_reason: Mutex::new(None),
            inner: Mutex::new(AgentInner::default()),
            cmd,
            out,
            pending_calls: Mutex::new(HashMap::new()),
            pending_lists: Mutex::new(HashMap::new()),
            pending_resolves: Mutex::new(HashMap::new()),
            resolve_gate: tokio::sync::Mutex::new(()),
            hands_cancel: Mutex::new(CancellationToken::new()),
            event_seq: AtomicU64::new(0),
            call_n: AtomicU64::new(0),
            secrets,
        })
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

    /// Told to stop, or being killed.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst) || self.kill_reason().is_some()
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
        self.send_out(Outbound::Event(AgentEvent { agent: self.id.clone(), epoch: self.epoch, seq, ts_ms: now_ms(), turn, body }));
    }

    /// The cached gateway target and its generation, unless its binding is due for refresh
    /// (`nest_hands_client::refresh_due`): then it is forgotten, so the caller resolves a fresh
    /// one instead of spending a bind on an `unauthorized`.
    pub fn hands_target(&self) -> Option<(HandsTarget, u64)> {
        let mut inner = self.inner.lock().unwrap();
        if inner.target.as_ref().is_some_and(|t| nest_hands_client::refresh_due(t, now_ms())) {
            inner.target = None;
        }
        inner.target.clone().map(|t| (t, inner.target_gen))
    }

    /// Cache a target; returns its generation.
    pub fn set_hands_target(&self, target: HandsTarget) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.target_gen += 1;
        inner.target = Some(target);
        inner.target_gen
    }

    /// Forget the target a call was using (a gateway refused it, or the sandbox moved mid-call),
    /// unless another call has stored a fresher one since.
    pub fn drop_target_if(&self, generation: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.target_gen == generation {
            inner.target = None;
        }
    }

    /// One `hands_resolve` round trip over the session channel. Dropping the future (a caller's
    /// timeout, a cancelled call) forgets the request, so a late answer is ignored.
    pub async fn resolve_hands_target(&self, timeout: Duration) -> Result<HandsOutcome, ResolveTimeout> {
        let req = RequestId(format!("req_{}", uuid::Uuid::new_v4().simple()));
        let (tx, rx) = oneshot::channel();
        self.pending_resolves.lock().unwrap().insert(req.clone(), tx);
        let _guard = PendingResolve { agent: self, req: req.clone() };
        self.send_out(Outbound::HandsResolve(req));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            _ => Err(ResolveTimeout),
        }
    }

    /// `hands_resolved` arrived on the session channel. An id nobody waits for (the caller gave
    /// up, or a duplicate answer) is logged and ignored.
    pub fn resolve_hands(&self, req: &RequestId, outcome: HandsOutcome) {
        match self.pending_resolves.lock().unwrap().remove(req) {
            Some(tx) => {
                let _ = tx.send(outcome);
            }
            None => tracing::debug!(agent = %self.id, request = %req.0, "hands_resolved for a request nobody awaits"),
        }
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
            // 128 random bits: calls are idempotent on their id, so stems must never collide (N9).
            None => format!("x{}", uuid::Uuid::new_v4().simple()),
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

    /// A cancel token for one hands call, cancelled by the next [`Agent::cancel_hands`].
    pub fn hands_token(&self) -> CancellationToken {
        self.hands_cancel.lock().unwrap().child_token()
    }

    /// Cancel every in-flight hands call (hard interrupt / kill).
    pub fn cancel_hands(&self) {
        std::mem::take(&mut *self.hands_cancel.lock().unwrap()).cancel();
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    fn agent(rt: &Runtime, epoch: u64) -> Arc<Agent> {
        let (cmd, _crx) = mpsc::unbounded_channel();
        let (out, _orx) = mpsc::unbounded_channel();
        Agent::new(AgentId("agt_r".into()), Epoch(epoch), PathBuf::from("/tmp"), None, vec![], rt.current_gen(), cmd, out)
    }

    /// A hard interrupt cancels every hands call in flight (each a child of the agent's token),
    /// and only those: a call started after it runs.
    #[test]
    fn cancel_hands_cancels_the_calls_in_flight_and_no_later_one() {
        let rt = Runtime::new(Config::default());
        let a = agent(&rt, 1);
        let (one, two) = (a.hands_token(), a.hands_token());
        two.cancel();
        assert!(!one.is_cancelled(), "a bridge's cancel of one call leaves the others");
        a.cancel_hands();
        assert!(one.is_cancelled());
        assert!(!a.hands_token().is_cancelled(), "a later call gets a fresh token");
    }

    /// N9: a call id outside a turn carries 128 random bits.
    #[test]
    fn a_call_id_outside_a_turn_has_a_128_bit_stem() {
        let rt = Runtime::new(Config::default());
        let a = agent(&rt, 1);
        let id = a.next_call_id().0;
        let stem = id.trim_start_matches("cal_x").split('-').next().unwrap().to_string();
        assert_eq!(stem.len(), 32, "{id}");
    }
}
