//! nestd side of the nestd ↔ agent runner protocol (`docs/interfaces/host-internal/nestd-runner/`).
//!
//! Lifecycle only: nestd keeps the *desired* set of brains and on every runner (re)connection
//! re-issues `agent_start` for each of them (the runner starts with no agents and kills every
//! brain when the nestd socket closes or the lease lapses). Nothing about hands crosses this
//! link: the runner reaches a sandbox's guest through the gateway with a binding it gets from
//! AgentDO, and the guest slot is configured by `agent_attach` from SandboxDO.
//!
//! Replay vs. stale exits: a runner that lost its nestd connection may still deliver
//! `agent_exited{fenced}` for brains it killed *before* the reconnect. Those must not cancel the
//! starts nestd just replayed, so for each replayed agent an `agent_exited{fenced}` is dropped
//! until that agent's `agent_started` arrives on the new connection.
//!
//! Access: the socket is `0660` (optional group), the peer uid is checked with `SO_PEERCRED`,
//! and only one runner is served at a time (the connection receives OAuth and host tokens).

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use std::collections::BTreeSet;

use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerCommand, RunnerEvent, StopMode};
use nest_protocol::host::{PROTOCOL_VERSION, Secret};
use nest_protocol::model::{AgentId, HostId, HostRole, TimestampMs};
use tokio::net::UnixListener;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

#[derive(Debug)]
pub enum RunnerNotice {
    Connected { runner_version: String, pid: u32 },
    Event(RunnerEvent),
    Disconnected,
}

#[derive(Default)]
struct State {
    desired: BTreeMap<AgentId, AgentStart>,
    token: Option<(Secret, TimestampMs)>,
    lease_valid_until: Option<TimestampMs>,
    conn: Option<UnboundedSender<RunnerCommand>>,
    /// Agents replayed on the current connection whose `agent_started` hasn't arrived yet.
    replayed: BTreeSet<AgentId>,
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

    pub fn agent_start(&self, start: AgentStart) {
        let agent = start.start.agent.clone();
        self.state.lock().expect("runner state").desired.insert(agent, start.clone());
        self.send(RunnerCommand::AgentStart(Box::new(start)));
    }

    pub fn agent_stop(&self, agent: &AgentId, mode: StopMode, reason: &str) {
        self.state.lock().expect("runner state").desired.remove(agent);
        self.send(RunnerCommand::AgentStop { agent: agent.clone(), mode, reason: reason.into() });
    }

    /// Kill these brains now (empty = all).
    pub fn fence(&self, agents: Vec<AgentId>, reason: &str) {
        {
            let mut st = self.state.lock().expect("runner state");
            if agents.is_empty() {
                st.desired.clear();
            } else {
                for a in &agents {
                    st.desired.remove(a);
                }
            }
        }
        self.send(RunnerCommand::Fence { agents, reason: reason.into() });
    }

    /// A brain exited on its own: forget it (it is restarted only by a new `agent_start`).
    pub fn forget(&self, agent: &AgentId) {
        self.state.lock().expect("runner state").desired.remove(agent);
    }

    pub fn desired(&self) -> Vec<AgentStart> {
        self.state.lock().expect("runner state").desired.values().cloned().collect()
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
    // Handshake + replay under the lock so concurrent commands queue behind it.
    {
        let mut st = state.lock().expect("runner state");
        let _ = tx.send(RunnerCommand::HelloAck { protocol_version: PROTOCOL_VERSION, host_id, host_role: role });
        if let Some((token, exp)) = st.token.clone() {
            let _ = tx.send(RunnerCommand::HostToken { token, expires_ms: exp });
        }
        if let Some(v) = st.lease_valid_until {
            let _ = tx.send(RunnerCommand::LeaseUpdate { valid_until_ms: v });
        }
        if st.conn.is_some() {
            drop(st);
            tracing::warn!("refusing a second concurrent agent-runner connection");
            return;
        }
        st.replayed = st.desired.keys().cloned().collect();
        for s in st.desired.values() {
            let _ = tx.send(RunnerCommand::AgentStart(Box::new(s.clone())));
        }
        st.conn = Some(tx.clone());
    }
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
                            if stale_exit(&state, &ev) {
                                tracing::info!(?ev, "dropping a stale fenced exit from before the runner reconnected");
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
    {
        let mut st = state.lock().expect("runner state");
        if st.conn.as_ref().is_some_and(|c| c.same_channel(&tx)) {
            st.conn = None;
            st.replayed.clear();
        }
    }
    let _ = notices.send(RunnerNotice::Disconnected);
}

/// Whether `ev` is an `agent_exited{fenced}` queued by the runner before this connection, for an
/// agent nestd has just replayed (cleared once that agent's `agent_started` arrives).
fn stale_exit(state: &Mutex<State>, ev: &RunnerEvent) -> bool {
    let mut st = state.lock().expect("runner state");
    match ev {
        RunnerEvent::AgentStarted { agent, .. } => {
            st.replayed.remove(agent);
            false
        }
        RunnerEvent::AgentExited { agent, reason: ExitReason::Fenced, .. } => st.replayed.contains(agent),
        RunnerEvent::AgentExited { agent, .. } => {
            st.replayed.remove(agent);
            false
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::control::{AgentStart as CpAgentStart, LaunchConfig, SystemPrompt};
    use nest_protocol::model::{AgentRole, WorkstreamId};
    use tokio::net::UnixStream;

    pub fn cp_start(agent: &str) -> CpAgentStart {
        CpAgentStart {
            agent: AgentId(agent.into()),
            role: AgentRole::Captain,
            workstream: WorkstreamId("ws_1".into()),
            resume: None,
            hands: None,
            launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Replace { text: "x".into() } },
            oauth_token: "tok".into(),
            session_ws_url: "ws://x".into(),
        }
    }

    async fn read(f: &mut Framed<UnixStream, LengthDelimitedCodec>) -> RunnerCommand {
        let b = tokio::time::timeout(std::time::Duration::from_secs(5), f.next()).await.unwrap().unwrap().unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    #[tokio::test]
    async fn replays_desired_agents_on_reconnect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner.sock");
        let (ntx, mut nrx) = mpsc::unbounded_channel();
        let link = RunnerLink::start(&path, HostId("hst_1".into()), HostRole::Burst, crate::proxy_link::Access::default(), ntx).unwrap();
        link.host_token(Secret("t1".into()), 99);
        link.agent_start(AgentStart { start: cp_start("agt_a"), config_dir: "/tmp/a".into() });

        let connect = || async {
            let s = UnixStream::connect(&path).await.unwrap();
            let mut f = Framed::new(s, LengthDelimitedCodec::new());
            let hello = RunnerEvent::Hello { protocol_version: PROTOCOL_VERSION, runner_version: "t".into(), pid: 7 };
            f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
            f
        };
        let mut f = connect().await;
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::HostToken { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_a"));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { pid: 7, .. })));

        // Events flow up; exits forget the agent.
        let ev = RunnerEvent::AgentExited { agent: AgentId("agt_a".into()), code: Some(0), signal: None, reason: nest_protocol::host::runner::ExitReason::Idle };
        f.send(bytes::Bytes::from(serde_json::to_vec(&ev).unwrap())).await.unwrap();
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { .. }))));
        link.forget(&AgentId("agt_a".into()));
        link.agent_start(AgentStart { start: cp_start("agt_b"), config_dir: "/tmp/b".into() });
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_b"));

        // Reconnect: only agt_b is replayed.
        drop(f);
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Disconnected)));
        let mut f = connect().await;
        let _ = read(&mut f).await;
        let _ = read(&mut f).await;
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_b"));
        link.fence(vec![], "lease");
        assert!(matches!(read(&mut f).await, RunnerCommand::Fence { ref agents, .. } if agents.is_empty()));
        assert!(link.desired().is_empty());
    }

    /// Docs review #4: after a reconnect, the runner's queued `agent_exited{fenced}` from the old
    /// connection must not cancel the replayed start; a real exit after `agent_started` still
    /// arrives. A second concurrent runner is refused.
    #[tokio::test]
    async fn stale_fenced_exit_after_replay_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runner.sock");
        let (ntx, mut nrx) = mpsc::unbounded_channel();
        let link = RunnerLink::start(&path, HostId("hst_1".into()), HostRole::Burst, crate::proxy_link::Access::default(), ntx).unwrap();
        link.agent_start(AgentStart { start: cp_start("agt_a"), config_dir: "/tmp/a".into() });
        let s = UnixStream::connect(&path).await.unwrap();
        let mut f = Framed::new(s, LengthDelimitedCodec::new());
        let hello = RunnerEvent::Hello { protocol_version: PROTOCOL_VERSION, runner_version: "t".into(), pid: 7 };
        f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
        assert!(matches!(read(&mut f).await, RunnerCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, RunnerCommand::AgentStart(_)));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Connected { .. })));

        // A second runner is refused while the first is connected.
        let mut f2 = Framed::new(UnixStream::connect(&path).await.unwrap(), LengthDelimitedCodec::new());
        f2.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.ok();
        let r = tokio::time::timeout(std::time::Duration::from_secs(5), f2.next()).await.unwrap();
        assert!(!matches!(r, Some(Ok(_))), "second runner must get nothing");

        let send = |ev: RunnerEvent| bytes::Bytes::from(serde_json::to_vec(&ev).unwrap());
        let a = AgentId("agt_a".into());
        f.send(send(RunnerEvent::AgentExited { agent: a.clone(), code: None, signal: Some(9), reason: ExitReason::Fenced })).await.unwrap();
        f.send(send(RunnerEvent::AgentStarted { agent: a.clone(), pid: 1, session: nest_protocol::model::SessionId("ses_x".into()), claude_version: "t".into(), capabilities: vec![] })).await.unwrap();
        f.send(send(RunnerEvent::AgentExited { agent: a.clone(), code: Some(0), signal: None, reason: ExitReason::Fenced })).await.unwrap();
        // Started arrives; the first (stale) exit was dropped; the later one is delivered.
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentStarted { .. }))));
        assert!(matches!(nrx.recv().await, Some(RunnerNotice::Event(RunnerEvent::AgentExited { code: Some(0), .. }))));
    }
}
