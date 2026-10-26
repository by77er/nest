//! nestd side of the nestd ↔ agent runner protocol (`docs/interfaces/host-internal/nestd-runner/`).
//!
//! Lifecycle only. The link holds the host's **one brain table** ([`Brain`]: hands, state, and
//! the runner connection its start went out on): it is what the fleet hello reports, what a
//! sandbox fence looks up, and the filter for runner events. Nothing about hands crosses this
//! link: the runner reaches a sandbox's guest through the gateway with a binding it gets from
//! AgentDO, and the guest slot is configured by `agent_attach` from SandboxDO.
//!
//! **No replay.** The runner kills every brain when the nestd socket closes. Each brain whose
//! start went out on the lost connection is reported as exited ([`RunnerNotice::Disconnected`]:
//! `crashed`, or `fenced` for one already fenced) and leaves the table, so AgentDO restarts it with
//! a current `agent_start` (its own session, fresh resume URLs and token). A stale copy of the
//! original start is never re-sent. A start that arrives while no runner is connected was never
//! sent: it waits in the table and goes out once on the next connection.
//!
//! **Fence.** A fenced brain leaves the report at once, but stays in the table until the runner
//! reports its exit (forwarded, so AgentDO restarts it only once the runner has let go of it) or
//! the connection drops. A fenced start that was never sent leaves the table at once and is
//! returned to the caller to report.
//!
//! **Stale events.** Runner events are accepted only for a brain whose start went out on the
//! current connection; an `agent_exited{fenced}` for a brain that hasn't reported
//! `agent_started` yet is one the runner queued before this connection, and is dropped.
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
use nest_protocol::model::{AgentId, AgentState, HostId, HostRole, TimestampMs};
use tokio::net::UnixListener;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

#[derive(Debug)]
pub enum RunnerNotice {
    Connected { runner_version: String, pid: u32 },
    Event(RunnerEvent),
    /// The runner is gone, and with it every brain started on that connection: report each as
    /// exited with the reason given.
    Disconnected { lost: Vec<(AgentId, ExitReason)> },
}

/// Where a brain's `agent_start` stands with the runner.
enum Sent {
    /// Received while no runner was connected; sent once on the next connection.
    Pending(Box<AgentStart>),
    /// Sent on runner connection `conn`; `started` once its `agent_started` arrived.
    On { conn: u64, started: bool },
}

/// A brain this host runs.
struct Brain {
    state: AgentState,
    sent: Sent,
    /// Fenced: no longer reported; gone once the runner reports the exit or the connection drops.
    fenced: bool,
}

#[derive(Default)]
struct State {
    brains: BTreeMap<AgentId, Brain>,
    token: Option<(Secret, TimestampMs)>,
    lease_valid_until: Option<TimestampMs>,
    conn: Option<UnboundedSender<RunnerCommand>>,
    /// Generation of the current (or last) runner connection.
    conn_gen: u64,
    /// Each agent's agent epoch from its latest `agent_start` here, for the exits nestd reports
    /// itself (a lost runner connection, a start never sent): AgentDO ignores an older start's exit.
    epochs: BTreeMap<AgentId, nest_protocol::model::Epoch>,
    /// Per agent, the highest agent epoch an `agent_stop{mode: kill}` named: a start at or below it
    /// (queued behind the kill's arrival) is refused. Kept for the process's life (one per agent).
    killed: BTreeMap<AgentId, nest_protocol::model::Epoch>,
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

    /// Record the brain and send its start now, or on the next connection. Returns whether it was
    /// dispatched now.
    pub fn agent_start(&self, start: AgentStart) -> bool {
        let mut st = self.state.lock().expect("runner state");
        let agent = start.start.agent.clone();
        st.epochs.insert(agent.clone(), start.start.agent_epoch());
        let (sent, dispatched) = match &st.conn {
            Some(c) => {
                let _ = c.send(RunnerCommand::AgentStart(Box::new(start)));
                (Sent::On { conn: st.conn_gen, started: false }, true)
            }
            None => (Sent::Pending(Box::new(start)), false),
        };
        st.brains.insert(agent, Brain { state: AgentState::Starting, sent, fenced: false });
        dispatched
    }

    /// Stop a brain. Without a runner there is nothing to stop: the brain leaves the table (a
    /// pending start is never sent). Otherwise it leaves when the runner reports the exit.
    pub fn agent_stop(&self, agent: &AgentId, mode: StopMode, reason: &str) {
        let mut st = self.state.lock().expect("runner state");
        match &st.conn {
            Some(c) => {
                let _ = c.send(RunnerCommand::AgentStop { agent: agent.clone(), mode, reason: reason.into() });
            }
            None => {
                st.brains.remove(agent);
            }
        }
    }

    /// Kill these brains now (empty = all). They leave the report at once. Returns the fenced
    /// brains whose start was never sent: they left the table, and no runner exit will come for
    /// them, so the caller reports them.
    pub fn fence(&self, agents: Vec<AgentId>, reason: &str) -> Vec<AgentId> {
        let mut st = self.state.lock().expect("runner state");
        let targets: Vec<AgentId> = if agents.is_empty() { st.brains.keys().cloned().collect() } else { agents.clone() };
        let mut unsent = vec![];
        for a in targets {
            let pending = match st.brains.get_mut(&a) {
                Some(b) if matches!(b.sent, Sent::Pending(_)) => true,
                Some(b) => {
                    b.fenced = true;
                    false
                }
                None => false,
            };
            if pending {
                st.brains.remove(&a);
                unsent.push(a);
            }
        }
        if let Some(c) = &st.conn {
            let _ = c.send(RunnerCommand::Fence { agents, reason: reason.into() });
        }
        unsent
    }

    /// The brains this host runs (fenced ones excluded), for the fleet hello.
    pub fn report(&self) -> Vec<AgentReport> {
        let st = self.state.lock().expect("runner state");
        st.brains.iter().filter(|(_, b)| !b.fenced).map(|(id, b)| AgentReport { agent: id.clone(), state: b.state }).collect()
    }

    /// Kill `agent`'s brain now (`agent_stop{mode: kill}` on arrival) and remember `epoch` as its
    /// tombstone. Returns whether a running brain at or below `epoch` was told to die (its exit then
    /// comes from the runner); `false` when none runs here (never started, gone, a start never sent,
    /// or only a newer start), so the caller reports the exit itself.
    pub fn kill(&self, agent: &AgentId, epoch: Option<nest_protocol::model::Epoch>, reason: &str) -> bool {
        let mut st = self.state.lock().expect("runner state");
        if let Some(e) = epoch {
            let k = st.killed.entry(agent.clone()).or_insert(e);
            if e > *k {
                *k = e;
            }
        }
        let newer = epoch.is_some_and(|e| st.epochs.get(agent).is_some_and(|cur| *cur > e));
        let sent = match st.brains.get(agent) {
            Some(b) if !newer && !b.fenced => matches!(b.sent, Sent::On { .. }),
            _ => false,
        };
        if newer {
            return false;
        }
        if !sent {
            // Never sent (or already fenced): it leaves the table without a runner exit.
            if st.brains.get(agent).is_some_and(|b| matches!(b.sent, Sent::Pending(_))) {
                st.brains.remove(agent);
            }
            return false;
        }
        match &st.conn {
            Some(c) => {
                let _ = c.send(RunnerCommand::AgentStop { agent: agent.clone(), mode: StopMode::Kill, reason: reason.into() });
                true
            }
            None => {
                st.brains.remove(agent);
                false
            }
        }
    }

    /// Whether a kill at or above `epoch` arrived for `agent` (its tombstone).
    pub fn killed_at_or_above(&self, agent: &AgentId, epoch: nest_protocol::model::Epoch) -> bool {
        self.state.lock().expect("runner state").killed.get(agent).is_some_and(|k| *k >= epoch)
    }

    /// The agent epoch of `agent`'s latest start here.
    pub fn epoch_of(&self, agent: &AgentId) -> Option<nest_protocol::model::Epoch> {
        self.state.lock().expect("runner state").epochs.get(agent).copied()
    }

    pub fn count(&self) -> usize {
        self.state.lock().expect("runner state").brains.values().filter(|b| !b.fenced).count()
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
            out = rx.recv() => {
                let Some(cmd) = out else { break };
                let Ok(bytes) = serde_json::to_vec(&cmd) else { continue };
                if framed.send(bytes::Bytes::from(bytes)).await.is_err() { break; }
            }
            inc = framed.next() => {
                match inc {
                    Some(Ok(b)) => match serde_json::from_slice::<RunnerEvent>(&b) {
                        Ok(ev) => {
                            if !accept_event(&state, conn, &ev) {
                                tracing::info!(?ev, "dropping a runner event for a brain not started on this connection");
                                continue;
                            }
                            let _ = notices.send(RunnerNotice::Event(ev));
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
        let gone: Vec<AgentId> = st.brains.iter().filter(|(_, b)| matches!(b.sent, Sent::On { .. })).map(|(id, _)| id.clone()).collect();
        gone.into_iter()
            .filter_map(|id| st.brains.remove(&id).map(|b| (id, if b.fenced { ExitReason::Fenced } else { ExitReason::Crashed })))
            .collect()
    };
    let _ = notices.send(RunnerNotice::Disconnected { lost });
}

/// Apply a runner event to the brain table; `false` drops it. Events about a brain count only if
/// its start went out on this connection (`conn`). An `agent_exited{fenced}` for a live brain
/// that hasn't reported `agent_started` is one the runner queued before this connection.
fn accept_event(state: &Mutex<State>, conn: u64, ev: &RunnerEvent) -> bool {
    let mut st = state.lock().expect("runner state");
    let (agent, exit) = match ev {
        RunnerEvent::AgentStarted { agent, .. } => (agent, None),
        RunnerEvent::AgentExited { agent, reason, .. } => (agent, Some(*reason)),
        _ => return true,
    };
    let Some(b) = st.brains.get_mut(agent) else { return false };
    let Sent::On { conn: c, started } = &mut b.sent else { return false };
    if *c != conn {
        return false;
    }
    match exit {
        None => {
            *started = true;
            b.state = AgentState::Ready;
            true
        }
        Some(ExitReason::Fenced) if !*started && !b.fenced => false,
        Some(_) => {
            st.brains.remove(agent);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::control::{AgentStart as CpAgentStart, HandsBinding, LaunchConfig, SystemPrompt};
    use nest_protocol::model::{AgentRole, Epoch, SandboxId, SessionId, WorkstreamId};
    use tokio::net::UnixStream;

    type Conn = Framed<UnixStream, LengthDelimitedCodec>;

    pub fn cp_start(agent: &str) -> CpAgentStart {
        CpAgentStart {
            agent: AgentId(agent.into()),
            role: AgentRole::Captain,
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
        let link = RunnerLink::start(&path, HostId("hst_1".into()), HostRole::Burst, crate::proxy_link::Access::default(), ntx).unwrap();
        (link, path, nrx)
    }

    fn started(agent: &AgentId) -> RunnerEvent {
        RunnerEvent::AgentStarted { agent: agent.clone(), pid: 1, session: SessionId("ses_x".into()), claude_version: "t".into(), capabilities: vec![] }
    }

    fn exited(agent: &AgentId, reason: ExitReason) -> RunnerEvent {
        RunnerEvent::AgentExited { agent: agent.clone(), code: None, signal: Some(9), reason, epoch: None }
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
        send(&mut f, started(&a)).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentStarted { .. }))));
        assert_eq!(link.report()[0].state, AgentState::Ready);

        drop(f);
        match nrx.recv().await {
            Some(RunnerNotice::Disconnected { lost }) => assert_eq!(lost, vec![(a.clone(), ExitReason::Crashed)]),
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
        send(&mut f, exited(&a, ExitReason::Fenced)).await;
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
        assert_eq!(link.fence(vec![AgentId("agt_p".into())], "test"), vec![AgentId("agt_p".into())]);
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
        send(&mut f, exited(&b, ExitReason::Fenced)).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { ref agent, .. })) if agent == &b));

        link.fence(vec![], "lease");
        assert!(matches!(read(&mut f).await, RunnerCommand::Fence { ref agents, .. } if agents.is_empty()));
        assert!(agents(&link).is_empty());
        drop(f);
        match nrx.recv().await {
            Some(RunnerNotice::Disconnected { lost }) => assert_eq!(lost, vec![(a, ExitReason::Fenced)], "only the brain whose exit never came"),
            other => panic!("disconnect: {other:?}"),
        }
    }

    /// Docs review #4: a runner's queued `agent_exited{fenced}` for an earlier brain must not cancel
    /// a start that just went out; a real exit after `agent_started` still arrives. A second
    /// concurrent runner is refused.
    #[tokio::test]
    async fn stale_fenced_exit_before_started_is_dropped() {
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
        send(&mut f, exited(&a, ExitReason::Fenced)).await;
        send(&mut f, started(&a)).await;
        send(&mut f, RunnerEvent::AgentExited { agent: a.clone(), code: Some(0), signal: None, reason: ExitReason::Fenced, epoch: None }).await;
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentStarted { .. }))));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { code: Some(0), .. }))));
        assert!(agents(&link).is_empty());
    }
}
