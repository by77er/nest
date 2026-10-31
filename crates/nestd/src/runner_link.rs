//! nestd side of the nestd ↔ agent runner protocol (`docs/interfaces/host-internal/nestd-runner/`).
//!
//! Lifecycle only. The link holds the host's **one brain table** ([`Brain`]: state, and the
//! runner connection its start went out on), keyed by **(agent, agent epoch)**: it is what the
//! fleet hello reports and the filter for runner events. Nothing about hands crosses this link:
//! the runner reaches a sandbox's guest through the gateway with a binding it gets from AgentDO,
//! and the guest slot is configured by `agent_attach` from SandboxDO.
//!
//! **Keyed by start.** Each `agent_start` is its own entry. `agent_started` marks the entry of its
//! epoch; an exit removes the entries of its agent at or below its epoch, never a newer start's
//! (a replaced brain's late exit can't remove its replacement). An event without an epoch is
//! dropped (only a runner of an older release, which never meets this nestd, sends one).
//!
//! **No replay.** The runner kills every brain when the nestd socket closes. Each brain whose
//! start went out on the lost connection is reported as exited ([`RunnerNotice::Disconnected`]:
//! `crashed`, or `fenced` for one already fenced, with its epoch) and leaves the table, so AgentDO
//! restarts it with a current `agent_start`. A stale copy of the original start is never re-sent.
//! A start that arrives while no runner is connected was never sent: it waits in the table and
//! goes out once on the next connection.
//!
//! **Fence.** A fenced brain leaves the report at once, but stays in the table until the runner
//! reports its exit or the connection drops. A fenced start that was never sent leaves the table
//! at once and is returned to the caller to report.
//!
//! **Kill.** `agent_stop{kill, epoch}` raises the agent's tombstone here (a start at or below it is
//! refused) and is forwarded with its epoch, so the runner keeps the same tombstone (a start it
//! hasn't registered yet never runs). [`RunnerLink::kill`] answers "nothing runs here" only when no
//! start at or below the epoch went out to the runner: an entry that went out gets its exit from
//! the runner, fenced or not.
//!
//! **What an exit means.** An exit reported at agent epoch `e` means no brain of the agent at or
//! below `e` runs here any more (AgentDO releases its brain record on it). So the exit of a start
//! refused under the tombstone is owed until the older starts that went out have exited
//! ([`RunnerLink::refused`]), and goes out with the last of their exits.
//!
//! Access: the socket is `0660` (optional group), the peer uid is checked with `SO_PEERCRED`,
//! and only one runner is served at a time (the connection receives OAuth and host tokens).

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};

use nest_protocol::control::AgentReport;
use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerCommand, RunnerEvent, StopMode};
use nest_protocol::host::{PROTOCOL_VERSION, Secret};
use nest_protocol::model::{AgentId, AgentState, Epoch, HostId, HostRole, TimestampMs};
use tokio::net::UnixListener;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

/// A forwarded kill whose brain hasn't exited after this long drops the runner connection.
pub const KILL_EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug)]
pub enum RunnerNotice {
    Connected { runner_version: String, pid: u32 },
    Event(RunnerEvent),
    /// The runner is gone, and with it every brain started on that connection: report each as
    /// exited, at its start's agent epoch, with the reason given.
    Disconnected { lost: Vec<(AgentId, Epoch, ExitReason)> },
}

/// Where a brain's `agent_start` stands with the runner.
enum Sent {
    /// Received while no runner was connected; sent once on the next connection.
    Pending(Box<AgentStart>),
    /// Sent on runner connection `conn`; `started` once its `agent_started` arrived.
    On { conn: u64, started: bool },
}

/// A brain start this host runs.
struct Brain {
    state: AgentState,
    sent: Sent,
    /// Fenced: no longer reported; gone once the runner reports the exit or the connection drops.
    fenced: bool,
}

#[derive(Default)]
struct State {
    /// Signalled to drop the current runner connection (the runner then kills every brain).
    drop_conn: Option<Arc<tokio::sync::Notify>>,
    /// How long a forwarded kill waits for its brain's exit before the connection is dropped.
    kill_exit_wait: Option<std::time::Duration>,
    /// One entry per (agent, agent epoch) start.
    brains: BTreeMap<(AgentId, Epoch), Brain>,
    token: Option<(Secret, TimestampMs)>,
    lease_valid_until: Option<TimestampMs>,
    conn: Option<UnboundedSender<RunnerCommand>>,
    /// Generation of the current (or last) runner connection.
    conn_gen: u64,
    /// Per agent, the highest agent epoch an `agent_stop{mode: kill}` named: a start at or below it
    /// (queued behind the kill's arrival) is refused. Kept for the process's life (one per agent).
    killed: BTreeMap<AgentId, Epoch>,
    /// Exits owed for refused starts, reported once no older start of the agent remains here.
    owed: BTreeMap<AgentId, std::collections::BTreeSet<Epoch>>,
}

impl State {
    /// The agent's entries, oldest start first.
    fn keys_of(&self, agent: &AgentId) -> Vec<(AgentId, Epoch)> {
        self.brains.keys().filter(|(a, _)| a == agent).cloned().collect()
    }

    /// Remove the agent's never-sent starts at or below `bound` (all for `None`); returns their epochs.
    fn drop_pending(&mut self, agent: &AgentId, bound: Option<Epoch>) -> Vec<Epoch> {
        let gone: Vec<(AgentId, Epoch)> = self
            .keys_of(agent)
            .into_iter()
            .filter(|(_, e)| bound.is_none_or(|b| *e <= b))
            .filter(|k| self.brains.get(k).is_some_and(|b| matches!(b.sent, Sent::Pending(_))))
            .collect();
        for k in &gone {
            self.brains.remove(k);
        }
        gone.into_iter().map(|(_, e)| e).collect()
    }

    /// Owed exits of `agent` that no remaining start at or below them holds back any more.
    fn owed_due(&mut self, agent: &AgentId) -> Vec<Epoch> {
        let lowest = self.keys_of(agent).first().map(|(_, e)| *e);
        let Some(set) = self.owed.get_mut(agent) else { return vec![] };
        let due: Vec<Epoch> = set.iter().copied().filter(|e| lowest.is_none_or(|l| l > *e)).collect();
        for e in &due {
            set.remove(e);
        }
        if set.is_empty() {
            self.owed.remove(agent);
        }
        due
    }
}

fn owed_exit(agent: &AgentId, epoch: Epoch) -> RunnerEvent {
    RunnerEvent::AgentExited { agent: agent.clone(), code: None, signal: None, reason: ExitReason::Fenced, epoch: Some(epoch) }
}

#[derive(Clone)]
pub struct RunnerLink {
    state: Arc<Mutex<State>>,
}

impl RunnerLink {
    pub fn start(path: &Path, host_id: HostId, role: HostRole, access: crate::proxy_link::Access, notices: UnboundedSender<RunnerNotice>) -> io::Result<RunnerLink> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        crate::proxy_link::secure_socket_path(path, access.gid)?;
        let link = RunnerLink { state: Arc::new(Mutex::new(State::default())) };
        let state = link.state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                match stream.peer_cred() {
                    Ok(c) if crate::config::SocketsConfig::allows(&access.allowed_uids, c.uid()) => {}
                    Ok(c) => {
                        tracing::warn!(uid = c.uid(), pid = ?c.pid(), "refusing runner connection from a disallowed uid");
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "refusing runner connection: no peer credentials");
                        continue;
                    }
                }
                if state.lock().expect("runner state").conn.is_some() {
                    tracing::warn!("refusing a second concurrent agent-runner connection");
                    continue;
                }
                let codec = LengthDelimitedCodec::builder().max_frame_length(nest_protocol::host::frame::MAX_FRAME).new_codec();
                let framed = Framed::new(stream, codec);
                tokio::spawn(serve(framed, state.clone(), host_id.clone(), role, notices.clone()));
            }
        });
        Ok(link)
    }

    fn send(&self, cmd: RunnerCommand) {
        if let Some(c) = &self.state.lock().expect("runner state").conn {
            let _ = c.send(cmd);
        }
    }

    pub fn host_token(&self, token: Secret, expires_ms: TimestampMs) {
        self.state.lock().expect("runner state").token = Some((token.clone(), expires_ms));
        self.send(RunnerCommand::HostToken { token, expires_ms });
    }

    pub fn lease(&self, valid_until_ms: TimestampMs) {
        self.state.lock().expect("runner state").lease_valid_until = Some(valid_until_ms);
        self.send(RunnerCommand::LeaseUpdate { valid_until_ms });
    }

    /// Record the start under (agent, epoch) and send it now, or on the next connection. Returns
    /// whether it was dispatched now.
    pub fn agent_start(&self, start: AgentStart) -> bool {
        let mut st = self.state.lock().expect("runner state");
        let key = (start.start.agent.clone(), start.start.agent_epoch());
        let (sent, dispatched) = match &st.conn {
            Some(c) => {
                let _ = c.send(RunnerCommand::AgentStart(Box::new(start)));
                (Sent::On { conn: st.conn_gen, started: false }, true)
            }
            None => (Sent::Pending(Box::new(start)), false),
        };
        st.brains.insert(key, Brain { state: AgentState::Starting, sent, fenced: false });
        dispatched
    }

    /// Stop a brain gracefully: the one at or below `epoch` (every one for `None`, a control plane
    /// that names none), never a newer start. A start never sent leaves the table at once and is
    /// returned (with its epoch) for the caller to report; a sent one leaves when the runner reports
    /// its exit. The epoch is forwarded.
    pub fn agent_stop(&self, agent: &AgentId, mode: StopMode, reason: &str, epoch: Option<Epoch>) -> Vec<Epoch> {
        let mut st = self.state.lock().expect("runner state");
        let unsent = st.drop_pending(agent, epoch);
        if let Some(c) = &st.conn {
            let _ = c.send(RunnerCommand::AgentStop { agent: agent.clone(), mode, reason: reason.into(), epoch });
        }
        unsent
    }

    /// Kill these brains now (empty = all). They leave the report at once. Returns the fenced
    /// starts that were never sent: they left the table, and no runner exit will come for them,
    /// so the caller reports them.
    pub fn fence(&self, agents: Vec<AgentId>, reason: &str) -> Vec<(AgentId, Epoch)> {
        let mut st = self.state.lock().expect("runner state");
        let keys: Vec<(AgentId, Epoch)> = st.brains.keys().filter(|(a, _)| agents.is_empty() || agents.contains(a)).cloned().collect();
        let mut unsent = vec![];
        for k in keys {
            let pending = match st.brains.get_mut(&k) {
                Some(b) if matches!(b.sent, Sent::Pending(_)) => true,
                Some(b) => {
                    b.fenced = true;
                    false
                }
                None => false,
            };
            if pending {
                st.brains.remove(&k);
                unsent.push(k);
            }
        }
        if let Some(c) = &st.conn {
            let _ = c.send(RunnerCommand::Fence { agents, reason: reason.into() });
        }
        unsent
    }

    /// The agents this host runs (fenced starts excluded; an agent once, in its newest start's
    /// state), for the fleet hello.
    pub fn report(&self) -> Vec<AgentReport> {
        let st = self.state.lock().expect("runner state");
        let mut out: BTreeMap<AgentId, AgentState> = BTreeMap::new();
        for ((id, _), b) in st.brains.iter().filter(|(_, b)| !b.fenced) {
            out.insert(id.clone(), b.state);
        }
        out.into_iter().map(|(agent, state)| AgentReport { agent, state }).collect()
    }

    /// Kill `agent`'s brain at or below `epoch` now (`agent_stop{mode: kill}` on arrival; `None`,
    /// from a control plane that names none: whatever runs) and remember `epoch` as its tombstone.
    /// Returns `true` when a start at or below it went out to the runner (fenced or not): the kill
    /// is forwarded with its epoch and the exit comes from the runner. `false` only when no such
    /// start went out (never started here, already exited, or never sent, which leaves the table
    /// now): the caller reports the exit itself.
    pub fn kill(&self, agent: &AgentId, epoch: Option<Epoch>, reason: &str) -> bool {
        let mut st = self.state.lock().expect("runner state");
        if let Some(e) = epoch {
            let k = st.killed.entry(agent.clone()).or_insert(e);
            if e > *k {
                *k = e;
            }
        }
        st.drop_pending(agent, epoch);
        let sent = st.keys_of(agent).into_iter().any(|(_, e)| epoch.is_none_or(|b| e <= b));
        if !sent {
            return false;
        }
        match &st.conn {
            Some(c) => {
                let _ = c.send(RunnerCommand::AgentStop { agent: agent.clone(), mode: StopMode::Kill, reason: reason.into(), epoch });
                // The narrower step before any wedge (M1): if the brain hasn't exited after the
                // wait, the runner connection is dropped, so the runner kills every brain here
                // (sandboxes are untouched) and their exits are reported. Reported without the
                // runner's confirmation (N17), on the same footing as any lost connection: the
                // runner SIGKILLs every brain's process group the moment its nestd socket closes,
                // before it could act again, and a runner that couldn't is one the lease lapse,
                // the expiry and STONITH handle.
                let (state, agent, conn_gen) = (self.state.clone(), agent.clone(), st.conn_gen);
                let wait = st.kill_exit_wait.unwrap_or(KILL_EXIT_WAIT);
                tokio::spawn(async move {
                    tokio::time::sleep(wait).await;
                    let st = state.lock().expect("runner state");
                    let out = st.keys_of(&agent).into_iter().any(|(_, e)| epoch.is_none_or(|b| e <= b));
                    if out && st.conn_gen == conn_gen && st.conn.is_some() {
                        tracing::error!(%agent, "a killed brain did not exit; dropping the runner connection");
                        if let Some(n) = &st.drop_conn {
                            n.notify_one();
                        }
                    }
                });
                true
            }
            // A sent start without a connection doesn't outlive the disconnect; nothing runs.
            None => false,
        }
    }

    /// Test seam: how long a forwarded kill waits for its brain's exit (default `KILL_EXIT_WAIT`).
    pub fn set_kill_exit_wait(&self, wait: std::time::Duration) {
        self.state.lock().expect("runner state").kill_exit_wait = Some(wait);
    }

    /// Whether a kill at or above `epoch` arrived for `agent` (its tombstone).
    pub fn killed_at_or_above(&self, agent: &AgentId, epoch: Epoch) -> bool {
        self.state.lock().expect("runner state").killed.get(agent).is_some_and(|k| *k >= epoch)
    }

    /// A start at `epoch` was refused under the tombstone: it never runs. Returns `true` when its
    /// exit may be reported now (no older start of the agent is out here); otherwise the exit is
    /// owed and goes out (`fenced`, at `epoch`) with the exit that clears the last of them.
    pub fn refused(&self, agent: &AgentId, epoch: Epoch) -> bool {
        let mut st = self.state.lock().expect("runner state");
        if st.keys_of(agent).iter().any(|(_, e)| *e <= epoch) {
            st.owed.entry(agent.clone()).or_default().insert(epoch);
            return false;
        }
        true
    }

    /// Brains (agents) running here, fenced ones excluded.
    pub fn count(&self) -> usize {
        self.report().len()
    }

    pub fn connected(&self) -> bool {
        self.state.lock().expect("runner state").conn.is_some()
    }
}

async fn serve(
    mut framed: Framed<tokio::net::UnixStream, LengthDelimitedCodec>,
    state: Arc<Mutex<State>>,
    host_id: HostId,
    role: HostRole,
    notices: UnboundedSender<RunnerNotice>,
) {
    let hello = match framed.next().await {
        Some(Ok(b)) => serde_json::from_slice::<RunnerEvent>(&b),
        _ => return,
    };
    let (runner_version, pid) = match hello {
        Ok(RunnerEvent::Hello { protocol_version, runner_version, pid }) if protocol_version == PROTOCOL_VERSION => (runner_version, pid),
        other => {
            tracing::warn!(?other, "bad runner hello");
            return;
        }
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<RunnerCommand>();
    let drop_conn = Arc::new(tokio::sync::Notify::new());
    // Handshake + pending starts under the lock so concurrent commands queue behind it.
    let conn = {
        let mut st = state.lock().expect("runner state");
        if st.conn.is_some() {
            drop(st);
            tracing::warn!("refusing a second concurrent agent-runner connection");
            return;
        }
        let _ = tx.send(RunnerCommand::HelloAck { protocol_version: PROTOCOL_VERSION, host_id, host_role: role });
        if let Some((token, exp)) = st.token.clone() {
            let _ = tx.send(RunnerCommand::HostToken { token, expires_ms: exp });
        }
        if let Some(v) = st.lease_valid_until {
            let _ = tx.send(RunnerCommand::LeaseUpdate { valid_until_ms: v });
        }
        st.conn_gen += 1;
        let conn = st.conn_gen;
        st.drop_conn = Some(drop_conn.clone());
        for b in st.brains.values_mut() {
            if matches!(b.sent, Sent::Pending(_))
                && let Sent::Pending(start) = std::mem::replace(&mut b.sent, Sent::On { conn, started: false })
            {
                let _ = tx.send(RunnerCommand::AgentStart(start));
            }
        }
        st.conn = Some(tx.clone());
        conn
    };
    let _ = notices.send(RunnerNotice::Connected { runner_version, pid });
    loop {
        tokio::select! {
            _ = drop_conn.notified() => break,
            out = rx.recv() => {
                let Some(cmd) = out else { break };
                let Ok(bytes) = serde_json::to_vec(&cmd) else { continue };
                if framed.send(bytes::Bytes::from(bytes)).await.is_err() { break; }
            }
            inc = framed.next() => {
                match inc {
                    Some(Ok(b)) => match serde_json::from_slice::<RunnerEvent>(&b) {
                        Ok(ev) => {
                            let out = accept_event(&state, conn, ev);
                            if out.is_empty() {
                                tracing::info!("dropping a runner event for a brain not started on this connection");
                            }
                            for ev in out {
                                let _ = notices.send(RunnerNotice::Event(ev));
                            }
                        }
                        Err(e) => tracing::warn!(error = %e, "bad runner event"),
                    },
                    _ => break,
                }
            }
        }
    }
    let lost = {
        let mut st = state.lock().expect("runner state");
        if st.conn.as_ref().is_some_and(|c| c.same_channel(&tx)) {
            st.conn = None;
        }
        // The runner killed every brain when the socket closed.
        let gone: Vec<(AgentId, Epoch)> = st.brains.iter().filter(|(_, b)| matches!(b.sent, Sent::On { .. })).map(|(k, _)| k.clone()).collect();
        let mut lost: Vec<(AgentId, Epoch, ExitReason)> = gone
            .into_iter()
            .filter_map(|k| st.brains.remove(&k).map(|b| (k.0, k.1, if b.fenced { ExitReason::Fenced } else { ExitReason::Crashed })))
            .collect();
        let agents: Vec<AgentId> = st.owed.keys().cloned().collect();
        for a in agents {
            for e in st.owed_due(&a) {
                lost.push((a.clone(), e, ExitReason::Fenced));
            }
        }
        lost
    };
    let _ = notices.send(RunnerNotice::Disconnected { lost });
}

/// Apply a runner event to the brain table; `None` drops it. Events about a brain count only if a
/// matching start went out on this connection (`conn`). An `agent_started` marks its epoch's
/// entry; an exit removes the agent's entries at or below its epoch and is forwarded with that
/// epoch. One without an epoch is dropped.
fn accept_event(state: &Mutex<State>, conn: u64, ev: RunnerEvent) -> Vec<RunnerEvent> {
    let mut st = state.lock().expect("runner state");
    let (agent, epoch, exit) = match &ev {
        RunnerEvent::AgentStarted { agent, epoch, .. } => (agent.clone(), *epoch, None),
        RunnerEvent::AgentExited { agent, reason, epoch, .. } => (agent.clone(), *epoch, Some(*reason)),
        _ => return vec![ev],
    };
    let Some(e) = epoch else { return vec![] };
    let on_conn = |b: &Brain| matches!(b.sent, Sent::On { conn: c, .. } if c == conn);
    match exit {
        None => {
            let Some(b) = st.brains.get_mut(&(agent, e)).filter(|b| on_conn(b)) else { return vec![] };
            if let Sent::On { started, .. } = &mut b.sent {
                *started = true;
            }
            b.state = AgentState::Ready;
            vec![ev]
        }
        Some(_) => {
            let gone: Vec<(AgentId, Epoch)> =
                st.keys_of(&agent).into_iter().filter(|k| k.1 <= e && st.brains.get(k).is_some_and(on_conn)).collect();
            if gone.is_empty() {
                return vec![];
            }
            for k in &gone {
                st.brains.remove(k);
            }
            let mut out = match ev {
                RunnerEvent::AgentExited { agent, code, signal, reason, .. } => vec![RunnerEvent::AgentExited { agent, code, signal, reason, epoch: Some(e) }],
                other => vec![other],
            };
            out.extend(st.owed_due(&agent).into_iter().map(|o| owed_exit(&agent, o)));
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::control::{AgentStart as CpAgentStart, HandsBinding, LaunchConfig, SystemPrompt};
    use nest_protocol::model::{Epoch, SandboxId, SessionId, WorkstreamId};
    use tokio::net::UnixStream;

    type Conn = Framed<UnixStream, LengthDelimitedCodec>;

    pub fn cp_start(agent: &str) -> CpAgentStart {
        CpAgentStart {
            agent: AgentId(agent.into()),
            role: None,
            workstream: WorkstreamId("ws_1".into()),
            epoch: Some(Epoch(1)),
            resume: None,
            hands: None,
            launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Replace { text: "x".into() } },
            oauth_token: "tok".into(),
            session_ws_url: "ws://x".into(),
        }
    }

    fn start(agent: &str) -> AgentStart {
        AgentStart { start: cp_start(agent), config_dir: format!("/tmp/{agent}") }
    }

    fn bound(agent: &str, sandbox: &str) -> AgentStart {
        let mut s = start(agent);
        s.start.hands = Some(HandsBinding { sandbox: SandboxId(sandbox.into()), epoch: None });
        s
    }

    async fn read(f: &mut Conn) -> RunnerCommand {
        let b = tokio::time::timeout(std::time::Duration::from_secs(5), f.next()).await.unwrap().unwrap().unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    async fn send(f: &mut Conn, ev: RunnerEvent) {
        f.send(bytes::Bytes::from(serde_json::to_vec(&ev).unwrap())).await.unwrap();
    }

    async fn connect(path: &Path) -> Conn {
        let mut f = Framed::new(UnixStream::connect(path).await.unwrap(), LengthDelimitedCodec::new());
        send(&mut f, RunnerEvent::Hello { protocol_version: PROTOCOL_VERSION, runner_version: "t".into(), pid: 7 }).await;
        f
    }

    fn link(dir: &Path) -> (RunnerLink, std::path::PathBuf, mpsc::UnboundedReceiver<RunnerNotice>) {
        let path = dir.join("runner.sock");
        let (ntx, nrx) = mpsc::unbounded_channel();
        let link = RunnerLink::start(&path, HostId("hst_1".into()), HostRole::Sandbox, crate::proxy_link::Access::default(), ntx).unwrap();
        (link, path, nrx)
    }

    fn started_at(agent: &AgentId, epoch: u64) -> RunnerEvent {
        RunnerEvent::AgentStarted { agent: agent.clone(), pid: 1, session: SessionId("ses_x".into()), claude_version: "t".into(), capabilities: vec![], epoch: Some(Epoch(epoch)) }
    }

    fn exited_at(agent: &AgentId, reason: ExitReason, epoch: u64) -> RunnerEvent {
        RunnerEvent::AgentExited { agent: agent.clone(), code: None, signal: Some(9), reason, epoch: Some(Epoch(epoch)) }
    }

    fn start_at(agent: &str, epoch: u64) -> AgentStart {
        let mut s = start(agent);
        s.start.epoch = Some(Epoch(epoch));
        s
    }

    /// Next notice that isn't `Connected`.
    async fn notice(nrx: &mut mpsc::UnboundedReceiver<RunnerNotice>) -> RunnerNotice {
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(5), nrx.recv()).await.unwrap().unwrap() {
                RunnerNotice::Connected { .. } => continue,
                n => return n,
            }
        }
    }

    /// Connected runner, past the handshake (and any pending starts it carried).
    async fn connected(path: &Path, nrx: &mut mpsc::UnboundedReceiver<RunnerNotice>) -> Conn {
        let mut f = connect(path).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { .. })));
        f
    }

    fn agents(link: &RunnerLink) -> Vec<String> {
        link.report().into_iter().map(|r| r.agent.0).collect()
    }

    /// nestd review #1 and #3: a start received with no runner goes out once on connect. When the
    /// runner goes away (killing its brains), each brain is reported lost (`crashed`, which AgentDO
    /// restarts with a current start) and leaves the table; the next connection gets no replay of
    /// the stale start, and a late event about the old brain is dropped.
    #[tokio::test]
    async fn a_lost_runner_reports_its_brains_exited_and_nothing_is_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        link.host_token(Secret("t1".into()), 99);
        let a = AgentId("agt_a".into());
        assert!(!link.agent_start(start("agt_a")), "no runner yet: pending");
        assert_eq!(agents(&link), vec!["agt_a"]);

        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::HostToken { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent == a), "the pending start goes out once");
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { pid: 7, .. })));
        send(&mut f, started_at(&a, 1)).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentStarted { .. }))));
        assert_eq!(link.report()[0].state, AgentState::Ready);

        drop(f);
        match nrx.recv().await {
            Some(RunnerNotice::Disconnected { lost }) => assert_eq!(lost, vec![(a.clone(), Epoch(1), ExitReason::Crashed)]),
            other => panic!("disconnect: {other:?}"),
        }
        assert!(agents(&link).is_empty(), "a lost brain is not reported in the hello");

        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::HostToken { .. }));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { .. })));
        link.lease(5);
        assert!(matches!(read(&mut f).await, RunnerCommand::LeaseUpdate { valid_until_ms: 5 }), "no stale agent_start replayed");
        // The runner's queued exit for the old brain is not news.
        send(&mut f, exited_at(&a, ExitReason::Fenced, 1)).await;
        send(&mut f, RunnerEvent::Pong { nonce: 1, agents: 0 }).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::Pong { .. }))));
    }

    /// nestd review #3: a fence takes brains out of the report at once (the one table); the
    /// runner's exit for them still reaches AgentDO, once. A start never sent is fenced on the spot
    /// and handed back to report.
    #[tokio::test]
    async fn a_fence_clears_the_brain_table() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        assert!(!link.agent_start(bound("agt_p", "sbx_1")), "pending");
        assert_eq!(link.fence(vec![AgentId("agt_p".into())], "test"), vec![(AgentId("agt_p".into()), Epoch(1))]);
        assert!(agents(&link).is_empty());

        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { .. })));
        let (a, b) = (AgentId("agt_a".into()), AgentId("agt_b".into()));
        assert!(link.agent_start(start("agt_a")));
        assert!(link.agent_start(bound("agt_b", "sbx_1")));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent == a), "the fenced pending start never goes out");
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent == b));

        assert!(link.fence(vec![b.clone()], "fenced").is_empty());
        assert!(matches!(read(&mut f).await, RunnerCommand::Fence { ref agents, .. } if agents == std::slice::from_ref(&b)));
        assert_eq!(agents(&link), vec!["agt_a"], "the fenced brain left the report");
        assert_eq!(link.count(), 1);
        send(&mut f, exited_at(&b, ExitReason::Fenced, 1)).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { ref agent, .. })) if agent == &b));

        link.fence(vec![], "lease");
        assert!(matches!(read(&mut f).await, RunnerCommand::Fence { ref agents, .. } if agents.is_empty()));
        assert!(agents(&link).is_empty());
        drop(f);
        match nrx.recv().await {
            Some(RunnerNotice::Disconnected { lost }) => assert_eq!(lost, vec![(a, Epoch(1), ExitReason::Fenced)], "only the brain whose exit never came"),
            other => panic!("disconnect: {other:?}"),
        }
    }

    /// An event without an epoch (from a runner of an older release) is dropped; the start's own
    /// events go through. A second concurrent runner is refused.
    #[tokio::test]
    async fn an_event_without_an_epoch_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        link.agent_start(start("agt_a"));
        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { .. })));

        // A second runner is refused while the first is connected.
        let mut f2 = connect(&path).await;
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), f2.next()).await.unwrap();
        assert!(!matches!(r, Some(Ok(_))), "second runner must get nothing");

        let a = AgentId("agt_a".into());
        let no_epoch = RunnerEvent::AgentExited { agent: a.clone(), code: None, signal: Some(9), reason: ExitReason::Fenced, epoch: None };
        send(&mut f, no_epoch).await;
        send(&mut f, started_at(&a, 1)).await;
        send(&mut f, RunnerEvent::AgentExited { agent: a.clone(), code: Some(0), signal: None, reason: ExitReason::Fenced, epoch: Some(Epoch(1)) }).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentStarted { .. }))));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { code: Some(0), .. }))));
        assert!(agents(&link).is_empty());
    }

    /// Fourth review H1: the table is keyed by (agent, epoch). After a same-host replacement the
    /// old brain's exit removes only its own entry: the new brain stays reported, its
    /// `agent_started` and its exit go through, and a kill for it is forwarded (with its epoch)
    /// instead of being answered "not running".
    #[tokio::test]
    async fn an_old_brains_exit_never_removes_its_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let mut f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 1)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent_epoch() == Epoch(1)));
        send(&mut f, started_at(&a, 1)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentStarted { .. })));
        // Restarted on this host under epoch 2; the runner replaces brain 1, whose exit comes late.
        assert!(link.agent_start(start_at("agt_a", 2)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent_epoch() == Epoch(2)));
        send(&mut f, exited_at(&a, ExitReason::Stopped, 1)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentExited { epoch: Some(Epoch(1)), .. })));
        assert_eq!(agents(&link), vec!["agt_a"], "brain 2 is still reported");
        send(&mut f, started_at(&a, 2)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentStarted { epoch: Some(Epoch(2)), .. })), "brain 2's started is not dropped");
        assert_eq!(link.report()[0].state, AgentState::Ready);
        assert!(link.kill(&a, Some(Epoch(2)), "moving"), "brain 2 runs: its exit comes from the runner");
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStop { mode: StopMode::Kill, epoch: Some(Epoch(2)), .. }), "the kill is forwarded with its epoch");
        send(&mut f, exited_at(&a, ExitReason::Stopped, 2)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentExited { epoch: Some(Epoch(2)), .. })), "brain 2's exit is not lost");
        assert!(agents(&link).is_empty());
    }

    /// Design rule 6: `kill` never answers "not running" for a start that went out to the runner,
    /// even a fenced one (its exit comes from the runner); it does for one at a newer epoch only,
    /// or for none. A start never sent leaves the table and is answered "not running".
    #[tokio::test]
    async fn kill_answers_not_running_only_when_nothing_at_or_below_its_epoch_went_out() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let a = AgentId("agt_a".into());
        assert!(!link.agent_start(start_at("agt_a", 3)), "pending");
        assert!(!link.kill(&a, Some(Epoch(3)), "x"), "never sent: nothing runs");
        assert!(agents(&link).is_empty(), "the unsent start left the table");
        assert!(link.killed_at_or_above(&a, Epoch(3)));
        let mut f = connected(&path, &mut nrx).await;
        assert!(link.agent_start(start_at("agt_a", 4)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(!link.kill(&a, Some(Epoch(3)), "x"), "only a newer start runs");
        assert!(link.fence(vec![a.clone()], "lease").is_empty());
        assert!(matches!(read(&mut f).await, RunnerCommand::Fence { .. }));
        assert!(link.kill(&a, Some(Epoch(4)), "x"), "a fenced start that went out still gets its exit from the runner");
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStop { epoch: Some(Epoch(4)), .. }));
    }

    /// An exit that names its epoch for a start that never reported `agent_started` (the runner
    /// refused it under a kill's tombstone) is forwarded.
    #[tokio::test]
    async fn an_exit_with_its_epoch_before_started_is_forwarded() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let mut f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 2)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        send(&mut f, exited_at(&a, ExitReason::Fenced, 2)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentExited { epoch: Some(Epoch(2)), .. })));
        assert!(agents(&link).is_empty());
    }

    /// A graceful stop of a start never sent ends it here and hands its epoch back to report; one
    /// naming an older epoch (D11) leaves a newer start alone, and the epoch is forwarded.
    #[tokio::test]
    async fn a_graceful_stop_of_an_unsent_start_returns_it() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let a = AgentId("agt_a".into());
        assert!(!link.agent_start(start_at("agt_a", 5)));
        assert!(link.agent_stop(&a, StopMode::Graceful, "x", Some(Epoch(4))).is_empty(), "a stop for epoch 4 spares the start at 5");
        assert_eq!(link.agent_stop(&a, StopMode::Graceful, "x", Some(Epoch(5))), vec![Epoch(5)]);
        assert!(agents(&link).is_empty());
        let mut f = connected(&path, &mut nrx).await;
        link.agent_stop(&a, StopMode::Graceful, "x", Some(Epoch(7)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStop { mode: StopMode::Graceful, epoch: Some(Epoch(7)), .. }));
    }

    /// An exit at an epoch means nothing of the agent at or below it runs here: a start refused
    /// under the tombstone while an older start is still out owes its exit until that one exits.
    #[tokio::test]
    async fn a_refused_starts_exit_waits_for_the_older_brain() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let mut f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 1)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(link.kill(&a, Some(Epoch(2)), "moving"));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStop { epoch: Some(Epoch(2)), .. }));
        assert!(link.killed_at_or_above(&a, Epoch(2)));
        assert!(!link.refused(&a, Epoch(2)), "brain 1 is still out: the exit for 2 is owed");
        send(&mut f, exited_at(&a, ExitReason::Stopped, 1)).await;
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentExited { epoch: Some(Epoch(1)), .. })));
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Event(RunnerEvent::AgentExited { epoch: Some(Epoch(2)), reason: ExitReason::Fenced, .. })), "the owed exit follows");
        assert!(link.refused(&a, Epoch(3)), "nothing older out: report now");
    }

    /// An owed exit whose older start is lost with the runner's connection goes out with the losses.
    #[tokio::test]
    async fn owed_exits_go_out_when_the_runner_is_lost() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        let f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 1)));
        link.kill(&a, Some(Epoch(2)), "x");
        assert!(!link.refused(&a, Epoch(2)));
        drop(f);
        match notice(&mut nrx).await {
            RunnerNotice::Disconnected { lost } => assert_eq!(lost, vec![(a.clone(), Epoch(1), ExitReason::Crashed), (a, Epoch(2), ExitReason::Fenced)]),
            other => panic!("{other:?}"),
        }
    }

    /// M1's narrower step: a forwarded kill whose brain never exits drops the runner connection
    /// (the runner kills every brain), and the brains are reported lost, sandboxes untouched.
    #[tokio::test]
    async fn a_kill_without_an_exit_drops_the_runner_connection() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        link.set_kill_exit_wait(std::time::Duration::from_millis(100));
        let mut f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 1)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(link.kill(&a, Some(Epoch(1)), "x"));
        match notice(&mut nrx).await {
            RunnerNotice::Disconnected { lost } => assert_eq!(lost, vec![(a, Epoch(1), ExitReason::Crashed)]),
            other => panic!("{other:?}"),
        }
    }

    /// The tombstone only rises: a lower kill never lowers it.
    #[tokio::test]
    async fn the_kill_tombstone_only_rises() {
        let dir = tempfile::tempdir().unwrap();
        let (link, _path, _nrx) = link(dir.path());
        let a = AgentId("agt_a".into());
        link.kill(&a, Some(Epoch(1)), "x");
        link.kill(&a, Some(Epoch(3)), "x");
        link.kill(&a, Some(Epoch(2)), "x");
        assert!(link.killed_at_or_above(&a, Epoch(3)));
        assert!(!link.killed_at_or_above(&a, Epoch(4)));
    }

    /// The drop is for the connection the kill went out on: a runner that reconnected since keeps
    /// its new connection.
    #[tokio::test]
    async fn a_late_kill_timer_never_drops_a_newer_connection() {
        let dir = tempfile::tempdir().unwrap();
        let (link, path, mut nrx) = link(dir.path());
        link.set_kill_exit_wait(std::time::Duration::from_millis(300));
        let mut f = connected(&path, &mut nrx).await;
        let a = AgentId("agt_a".into());
        assert!(link.agent_start(start_at("agt_a", 1)));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(link.kill(&a, Some(Epoch(1)), "x"));
        drop(f);
        assert!(matches!(notice(&mut nrx).await, RunnerNotice::Disconnected { .. }));
        let _g = connected(&path, &mut nrx).await;
        // A start at or below the old kill's epoch out on the new connection.
        assert!(link.agent_start(start_at("agt_a", 1)));
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        assert!(link.connected(), "the new connection was dropped by the old kill's timer");
    }
}
