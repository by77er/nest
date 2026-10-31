//! The session channel: one WebSocket per active agent to AgentDO.
//!
//! - Reliable messages (`events`, `tool_call`) get per-direction seqs and stay queued until
//!   AgentDO's cumulative `ack`; after a reconnect they're resent past `hello_ack.last_seq`.
//! - Inbound reliable messages are deduplicated by seq and acknowledged cumulatively.
//! - Session bytes go as `segment`s (ordered by offset); `hello_ack.durable_bytes` rewinds.
//! - Events are batched every `batch_interval` (or at 100), consecutive state changes coalesced.
//! - `Close` (the brain exited) flushes the session tail and events, then keeps the channel (and
//!   reconnects) until AgentDO has acked everything and the session bytes are durable, or
//!   [`CLOSE_FLUSH`] passes — so a brain exiting during an AgentDO blip still lands its last turns.
//! - A timed-out platform call is abandoned: an unacked copy is replaced by `cancel_call` (same
//!   seq), and a fresh `cancel_call` tells AgentDO to drop it if it already arrived.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::{AgentToRunner, HandsOutcome, RunnerHello, RunnerToAgent, ToolCall};
use nest_protocol::model::{self, AgentEvent, AgentEventBody, SessionId, Seq, error_codes};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::runtime::{Agent, AgentCmd, Outbound, Runtime};
use crate::tailer::Tailer;

/// Flush an event batch early at this size.
pub const MAX_BATCH: usize = 100;
/// How long a closing session keeps trying to make everything durable.
pub const CLOSE_FLUSH: Duration = Duration::from_secs(30);

enum Step {
    Reconnect,
    Close,
}

pub struct Session {
    pub rt: Arc<Runtime>,
    pub agent: Arc<Agent>,
    pub url: String,
    pub tailer: Tailer,
    pub session: Option<SessionId>,
    /// Signalled once after the first successful `hello_ack`.
    pub opened: Option<oneshot::Sender<()>>,
    /// Random per brain process; lets AgentDO reset the channel lineage after a restart.
    pub instance_id: String,
}

struct State {
    next_seq: u64,
    unacked: VecDeque<(u64, RunnerToAgent)>,
    last_in: u64,
    batch: Vec<AgentEvent>,
    /// Session bytes AgentDO reported durable.
    durable: u64,
    /// `hands_resolve` requests made while disconnected, sent right after the next `hello_ack`.
    resolves: Vec<model::RequestId>,
    /// Set by `Close`: give up at this instant.
    close_deadline: Option<tokio::time::Instant>,
}

impl State {
    fn closing(&self) -> bool {
        self.close_deadline.is_some()
    }

    fn close_expired(&self) -> bool {
        self.close_deadline.is_some_and(|d| tokio::time::Instant::now() >= d)
    }

    /// Abandon a timed-out platform call without breaking the in-order seq lineage. If the call is
    /// still unacked, it is replaced in place by a `cancel_call` with the same seq (so a resend can
    /// never execute it); a fresh `cancel_call` is always queued too, covering a call AgentDO has
    /// already received (a pending ask stops waiting). AgentDO handles cancels idempotently.
    fn abandon(&mut self, call: &model::CallId) -> RunnerToAgent {
        let reason = "timed out in the runner; the model was told the outcome is unknown".to_string();
        for (seq, m) in self.unacked.iter_mut() {
            if matches!(m, RunnerToAgent::ToolCall(tc) if &tc.call == call) {
                *m = RunnerToAgent::CancelCall { seq: Seq(*seq), call: call.clone(), reason: reason.clone() };
            }
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let m = RunnerToAgent::CancelCall { seq: Seq(seq), call: call.clone(), reason };
        self.unacked.push_back((seq, m.clone()));
        m
    }
}

impl Session {
    pub async fn run(mut self, mut out: mpsc::UnboundedReceiver<Outbound>) {
        let mut st = State {
            next_seq: 1,
            unacked: VecDeque::new(),
            last_in: 0,
            batch: Vec::new(),
            durable: 0,
            resolves: Vec::new(),
            close_deadline: None,
        };
        let mut backoff = Duration::from_millis(100);
        loop {
            match self.connect_once(&mut st, &mut out).await {
                Ok(Step::Close) => return,
                Ok(Step::Reconnect) => backoff = Duration::from_millis(100),
                Err(e) => tracing::warn!(agent = %self.agent.id, "session channel: {e:#}"),
            }
            if st.close_expired() {
                tracing::warn!(agent = %self.agent.id, unacked = st.unacked.len(), "giving up flushing the session channel");
                return;
            }
            // Keep absorbing outbound messages while disconnected so nothing is lost.
            let deadline = tokio::time::sleep(backoff);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    o = out.recv(), if !st.closing() => match o {
                        Some(o) => self.absorb(&mut st, o),
                        None => { st.close_deadline.get_or_insert(tokio::time::Instant::now() + CLOSE_FLUSH); }
                    },
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(5));
        }
    }

    /// Handle an outbound message without a connection.
    fn absorb(&mut self, st: &mut State, o: Outbound) {
        match o {
            Outbound::Event(e) => push_event(&mut st.batch, e),
            Outbound::ToolCall { call, turn, name, arguments } => {
                let seq = st.next_seq;
                st.next_seq += 1;
                st.unacked.push_back((seq, RunnerToAgent::ToolCall(ToolCall { seq: Seq(seq), call, turn, name, arguments })));
            }
            Outbound::AbandonCall(call) => {
                st.abandon(&call);
            }
            Outbound::HandsResolve(req) => st.resolves.push(req),
            Outbound::ToolsListRequest(_) | Outbound::Reconnect => {}
            Outbound::SetTranscript(p) => self.tailer.set_path(p),
            Outbound::SetSession(s) => self.session = Some(s),
            Outbound::Close => {
                st.close_deadline.get_or_insert(tokio::time::Instant::now() + CLOSE_FLUSH);
            }
        }
    }

    /// Everything sent is acked and the session tail is durable.
    fn drained(&self, st: &State) -> bool {
        st.batch.is_empty() && st.unacked.is_empty() && st.durable >= self.tailer.sent()
    }

    async fn connect_once(&mut self, st: &mut State, out: &mut mpsc::UnboundedReceiver<Outbound>) -> anyhow::Result<Step> {
        let token = {
            let mut rx = self.rt.host_token.subscribe();
            loop {
                if let Some(t) = rx.borrow().clone() {
                    break t;
                }
                if st.close_expired() {
                    return Ok(Step::Close);
                }
                tokio::select! {
                    r = rx.changed() => r?,
                    o = out.recv(), if !st.closing() => match o {
                        Some(o) => self.absorb(st, o),
                        None => { st.close_deadline.get_or_insert(tokio::time::Instant::now() + CLOSE_FLUSH); }
                    },
                    _ = tokio::time::sleep(Duration::from_millis(500)), if st.closing() => {}
                }
            }
        };
        let mut req = self.url.as_str().into_client_request()?;
        req.headers_mut().insert("Authorization", format!("Bearer {}", token.0).parse()?);
        let (ws, _) = tokio_tungstenite::connect_async(req).await?;
        let (mut tx, mut rx) = ws.split();

        let hello = RunnerToAgent::Hello(RunnerHello {
            protocol_version: model::PROTOCOL_VERSION,
            agent: self.agent.id.clone(),
            host: self.rt.host(),
            instance_id: self.instance_id.clone(),
            epoch: self.agent.epoch,
            session: self.session.clone(),
            local_bytes: self.tailer.local_bytes(),
            last_seq: (st.last_in > 0).then_some(Seq(st.last_in)),
        });
        tx.send(text(&hello)?).await?;
        let ack = loop {
            match rx.next().await {
                Some(Ok(Message::Text(t))) => break serde_json::from_str::<AgentToRunner>(&t)?,
                Some(Ok(Message::Close(_))) | None => anyhow::bail!("closed before hello_ack"),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.into()),
            }
        };
        let (durable, peer_last) = match ack {
            AgentToRunner::HelloAck { durable_bytes, last_seq, .. } => (durable_bytes, last_seq.map(|s| s.0).unwrap_or(0)),
            AgentToRunner::Error { error } => {
                if error.code == error_codes::STALE_EPOCH {
                    self.agent.command(AgentCmd::StaleEpoch);
                }
                anyhow::bail!("session hello rejected: {} {}", error.code, error.message)
            }
            other => anyhow::bail!("expected hello_ack, got {other:?}"),
        };
        self.tailer.rewind(durable);
        st.durable = durable;
        st.unacked.retain(|(s, _)| *s > peer_last);
        for (_, m) in &st.unacked {
            tx.send(text(m)?).await?;
        }
        for request in std::mem::take(&mut st.resolves) {
            tx.send(text(&RunnerToAgent::HandsResolve { request })?).await?;
        }
        if let Some(o) = self.opened.take() {
            let _ = o.send(());
        }

        if st.closing() {
            self.flush_tail(&mut tx).await?;
            self.flush_events(st, &mut tx).await?;
        }

        let mut batch_tick = tokio::time::interval(self.rt.cfg.batch_interval);
        let mut tail_tick = tokio::time::interval(self.rt.cfg.tail_interval);
        loop {
            if st.closing() && (self.drained(st) || st.close_expired()) {
                let _ = tx.close().await;
                return Ok(Step::Close);
            }
            tokio::select! {
                m = rx.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        let msg: AgentToRunner = match serde_json::from_str(&t) {
                            Ok(m) => m,
                            Err(e) => { tracing::warn!("bad AgentToRunner: {e}"); continue; }
                        };
                        if let Some(reply) = self.inbound(st, msg) {
                            tx.send(text(&reply)?).await?;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => tx.send(Message::Pong(p)).await?,
                    Some(Ok(Message::Close(_))) | None => anyhow::bail!("session channel closed by peer"),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                },
                o = out.recv(), if !st.closing() => {
                    let Some(o) = o else {
                        st.close_deadline.get_or_insert(tokio::time::Instant::now() + CLOSE_FLUSH);
                        continue;
                    };
                    match o {
                        Outbound::Event(e) => {
                            push_event(&mut st.batch, e);
                            if st.batch.len() >= MAX_BATCH {
                                self.flush_events(st, &mut tx).await?;
                            }
                        }
                        Outbound::ToolCall { call, turn, name, arguments } => {
                            send_reliable(st, &mut tx, |seq| RunnerToAgent::ToolCall(ToolCall { seq, call, turn, name, arguments })).await?;
                        }
                        Outbound::AbandonCall(call) => {
                            let m = st.abandon(&call);
                            tx.send(text(&m)?).await?;
                        }
                        Outbound::ToolsListRequest(request) => tx.send(text(&RunnerToAgent::ToolsListRequest { request })?).await?,
                        Outbound::HandsResolve(request) => tx.send(text(&RunnerToAgent::HandsResolve { request })?).await?,
                        Outbound::SetTranscript(p) => self.tailer.set_path(p),
                        Outbound::SetSession(s) => self.session = Some(s),
                        Outbound::Reconnect => {
                            let _ = tx.close().await;
                            return Ok(Step::Reconnect);
                        }
                        Outbound::Close => {
                            st.close_deadline = Some(tokio::time::Instant::now() + CLOSE_FLUSH);
                            self.flush_tail(&mut tx).await?;
                            self.flush_events(st, &mut tx).await?;
                        }
                    }
                }
                _ = batch_tick.tick() => self.flush_events(st, &mut tx).await?,
                _ = tail_tick.tick() => self.flush_tail(&mut tx).await?,
            }
        }
    }

    /// Handle one inbound message; returns an immediate reply (acks).
    fn inbound(&mut self, st: &mut State, msg: AgentToRunner) -> Option<RunnerToAgent> {
        let reliable_seq = match &msg {
            AgentToRunner::RunTurn { seq, .. }
            | AgentToRunner::Inbox { seq, .. }
            | AgentToRunner::Interrupt { seq, .. }
            | AgentToRunner::CacheUpdate { seq, .. }
            | AgentToRunner::ToolResult { seq, .. } => Some(seq.0),
            _ => None,
        };
        if let Some(seq) = reliable_seq {
            if seq <= st.last_in {
                return Some(RunnerToAgent::Ack { up_to: Seq(st.last_in) });
            }
            st.last_in = seq;
        }
        let a = &self.agent;
        match msg {
            AgentToRunner::RunTurn { turn, input, .. } => a.command(AgentCmd::RunTurn { turn, input }),
            AgentToRunner::Inbox { message, .. } => a.command(AgentCmd::Inbox(message)),
            AgentToRunner::Interrupt { turn, .. } => a.command(AgentCmd::Interrupt { turn }),
            AgentToRunner::CacheUpdate { cache, .. } => a.set_cache(cache),
            AgentToRunner::ToolResult { call, outcome, .. } => a.resolve_call(&call, outcome),
            AgentToRunner::ToolsList { request, tools } => a.resolve_tools(&request, tools),
            // Only `outcome`: every AgentDO since #30 sends it (the other fields are the previous
            // release's shape).
            AgentToRunner::HandsResolved { request, outcome, .. } => {
                let outcome = outcome.map(|o| *o).unwrap_or_else(|| HandsOutcome::Error {
                    error: model::ErrorBody { code: error_codes::INVALID_MESSAGE.into(), message: "hands_resolved carried no outcome".into(), retryable: false },
                    retry_after_ms: None,
                });
                a.resolve_hands(&request, outcome);
            }
            AgentToRunner::Ack { up_to } => st.unacked.retain(|(s, _)| *s > up_to.0),
            AgentToRunner::SegmentAck { durable_bytes, .. } => {
                st.durable = st.durable.max(durable_bytes);
                self.tailer.confirm();
            }
            AgentToRunner::HelloAck { .. } => {}
            AgentToRunner::Error { error } => {
                tracing::warn!(agent = %a.id, code = %error.code, "AgentDO error: {}", error.message);
                if error.code == error_codes::STALE_EPOCH {
                    a.command(AgentCmd::StaleEpoch);
                } else if error.code == error_codes::INVALID_MESSAGE {
                    a.send_out(Outbound::Reconnect);
                }
            }
        }
        reliable_seq.map(|_| RunnerToAgent::Ack { up_to: Seq(st.last_in) })
    }

    async fn flush_events<S>(&mut self, st: &mut State, tx: &mut S) -> anyhow::Result<()>
    where
        S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    {
        if st.batch.is_empty() {
            return Ok(());
        }
        let events = std::mem::take(&mut st.batch);
        send_reliable(st, tx, |seq| RunnerToAgent::Events { seq, events }).await
    }

    async fn flush_tail<S>(&mut self, tx: &mut S) -> anyhow::Result<()>
    where
        S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    {
        let Some(session) = self.session.clone() else { return Ok(()) };
        let chunks = match self.tailer.poll() {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(agent = %self.agent.id, "tail {}: {e}", self.tailer.path().display());
                return Ok(());
            }
        };
        for c in chunks {
            let m = RunnerToAgent::Segment {
                session: session.clone(),
                offset: c.offset,
                base: c.base,
                data_b64: base64::engine::general_purpose::STANDARD.encode(&c.data),
            };
            tx.send(text(&m)?).await?;
        }
        Ok(())
    }
}

/// Assign the next seq, keep the message for resending, then send it. Kept first: a send that
/// fails (the usual way a broken socket shows) leaves it queued, so the next connection resends
/// it under the same seq and AgentDO never sees a gap.
async fn send_reliable<S>(st: &mut State, tx: &mut S, make: impl FnOnce(Seq) -> RunnerToAgent) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let seq = st.next_seq;
    st.next_seq += 1;
    let m = make(Seq(seq));
    let frame = text(&m)?;
    st.unacked.push_back((seq, m));
    tx.send(frame).await?;
    Ok(())
}

/// Append, coalescing consecutive state changes (only the latest state matters).
fn push_event(batch: &mut Vec<AgentEvent>, e: AgentEvent) {
    if matches!(e.body, AgentEventBody::StateChanged { .. })
        && let Some(last) = batch.last_mut()
        && matches!(last.body, AgentEventBody::StateChanged { .. })
        && last.turn == e.turn
    {
        *last = e;
        return;
    }
    batch.push(e);
}

fn text<T: serde::Serialize>(m: &T) -> anyhow::Result<Message> {
    Ok(Message::Text(serde_json::to_string(m)?.into()))
}

/// Start the session task for an agent.
pub fn spawn(
    rt: Arc<Runtime>,
    agent: Arc<Agent>,
    url: String,
    transcript: PathBuf,
    session: Option<SessionId>,
    out: mpsc::UnboundedReceiver<Outbound>,
) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    let tailer = Tailer::new(transcript, agent.secrets.clone());
    let s = Session { rt, agent, url, tailer, session, opened: Some(tx), instance_id: format!("rin_{}", uuid::Uuid::new_v4().simple()) };
    tokio::spawn(s.run(out));
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::{AgentId, AgentState, Epoch};

    fn ev(seq: u64, body: AgentEventBody) -> AgentEvent {
        AgentEvent { agent: AgentId("agt_a".into()), epoch: Epoch(1), seq: Seq(seq), ts_ms: 0, turn: None, body }
    }

    #[test]
    fn coalesces_consecutive_state_changes() {
        let mut b = Vec::new();
        push_event(&mut b, ev(1, AgentEventBody::StateChanged { state: AgentState::Working, detail: None }));
        push_event(&mut b, ev(2, AgentEventBody::StateChanged { state: AgentState::Compacting, detail: None }));
        push_event(&mut b, ev(3, AgentEventBody::AssistantText { text: "x".into() }));
        push_event(&mut b, ev(4, AgentEventBody::StateChanged { state: AgentState::Idle, detail: None }));
        assert_eq!(b.iter().map(|e| e.seq.0).collect::<Vec<_>>(), [2, 3, 4]);
    }

    /// A sink whose every send fails, as a broken socket's does.
    struct BrokenSink;

    impl futures_util::Sink<Message> for BrokenSink {
        type Error = tokio_tungstenite::tungstenite::Error;
        fn poll_ready(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn start_send(self: std::pin::Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
            Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed)
        }
        fn poll_flush(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(self: std::pin::Pin<&mut Self>, _: &mut std::task::Context<'_>) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// R1: a batch whose send fails stays queued under its seq, so the next connection resends it
    /// and AgentDO sees no gap. Before, the seq was spent and the batch dropped: AgentDO answered
    /// every later batch with a gap, and the channel stayed wedged for the brain's life.
    #[tokio::test]
    async fn a_batch_whose_send_fails_is_resent_under_its_seq() {
        let rt = Runtime::new(crate::config::Config::default());
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, _orx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_s".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        let mut session = Session {
            rt,
            agent,
            url: String::new(),
            tailer: Tailer::new(std::env::temp_dir().join("nest-r1-none.jsonl"), vec![]),
            session: None,
            opened: None,
            instance_id: "rin_t".into(),
        };
        let mut st = State {
            next_seq: 1,
            unacked: VecDeque::new(),
            last_in: 0,
            batch: vec![ev(1, AgentEventBody::AssistantText { text: "x".into() })],
            durable: 0,
            resolves: Vec::new(),
            close_deadline: None,
        };
        assert!(session.flush_events(&mut st, &mut BrokenSink).await.is_err());
        st.batch.push(ev(2, AgentEventBody::AssistantText { text: "y".into() }));
        assert!(session.flush_events(&mut st, &mut BrokenSink).await.is_err());
        let kept: Vec<(u64, usize)> = st
            .unacked
            .iter()
            .map(|(seq, m)| match m {
                RunnerToAgent::Events { seq: s, events } => {
                    assert_eq!(s.0, *seq);
                    (*seq, events.len())
                }
                m => panic!("{m:?}"),
            })
            .collect();
        assert_eq!(kept, [(1, 1), (2, 1)], "both batches wait for the next connection, seqs 1 and 2");
    }

    #[test]
    fn abandoning_a_call_keeps_the_seq_lineage_contiguous() {
        let call = model::CallId("cal_t1-1".into());
        let tc = |seq| RunnerToAgent::ToolCall(ToolCall { seq: Seq(seq), call: call.clone(), turn: None, name: "notify".into(), arguments: serde_json::json!({}) });
        let mut st = State {
            next_seq: 3,
            unacked: VecDeque::from([(1, tc(1)), (2, tc(2))]),
            last_in: 0,
            batch: Vec::new(),
            durable: 0,
            resolves: Vec::new(),
            close_deadline: None,
        };
        st.unacked[1].1 = RunnerToAgent::Events { seq: Seq(2), events: vec![] };
        let fresh = st.abandon(&call);
        // The unacked copy became a cancel at the same seq; a fresh cancel follows at the next seq.
        assert!(matches!(&st.unacked[0].1, RunnerToAgent::CancelCall { seq: Seq(1), call: c, .. } if c == &call));
        assert!(matches!(&fresh, RunnerToAgent::CancelCall { seq: Seq(3), .. }));
        let seqs: Vec<u64> = st.unacked.iter().map(|(s, _)| *s).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        assert_eq!(st.next_seq, 4);
        assert!(!st.unacked.iter().any(|(_, m)| matches!(m, RunnerToAgent::ToolCall(_))));
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use crate::config::Config;
    use nest_protocol::control::HandsOutcome;
    use nest_protocol::control::HandsBinding;
    use nest_protocol::gateway::{GuestInfo, HandsTarget};
    use nest_protocol::model::{AgentId, Epoch, SandboxId, Secret};
    use tokio::net::TcpListener;

    /// A `hands_resolve` made while the session channel is still down (no host token yet) is
    /// queued and sent after `hello_ack`, and its answer reaches the waiter.
    #[tokio::test]
    async fn a_resolve_made_while_disconnected_is_sent_after_hello_ack() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_q/session", listener.local_addr().unwrap());
        let target = HandsTarget {
            url: "ws://127.0.0.1:1".into(),
            sandbox: Some(SandboxId("sbx_q".into())),
            epoch: Some(Epoch(3)),
            binding: Secret("nbd_x.y".into()),
            guest: GuestInfo { protocol_version: 1, capabilities: vec![] },
            edge: None,
        };
        let t2 = target.clone();
        // AgentDO: hello → hello_ack, then answers the one hands_resolve it receives.
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut wtx, mut wrx) = ws.split();
            let mut saw_resolve = false;
            while let Some(Ok(m)) = wrx.next().await {
                let Message::Text(t) = m else { continue };
                match serde_json::from_str::<RunnerToAgent>(&t).unwrap() {
                    RunnerToAgent::Hello(_) => {
                        let ack = AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None };
                        wtx.send(Message::Text(serde_json::to_string(&ack).unwrap().into())).await.unwrap();
                    }
                    RunnerToAgent::HandsResolve { request } => {
                        saw_resolve = true;
                        let outcome = Some(Box::new(HandsOutcome::Ok { hands: t2.clone() }));
                        let m = AgentToRunner::HandsResolved { request, outcome, hands: None, error: None, retry_after_ms: None };
                        wtx.send(Message::Text(serde_json::to_string(&m).unwrap().into())).await.unwrap();
                        break;
                    }
                    _ => {}
                }
            }
            saw_resolve
        });
        let rt = Runtime::new(Config { batch_interval: Duration::from_millis(50), tail_interval: Duration::from_millis(50), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let agent = Agent::new(
            AgentId("agt_q".into()),
            Epoch(3),
            std::env::temp_dir(),
            Some(HandsBinding { sandbox: SandboxId("sbx_q".into()), epoch: None }),
            vec![],
            0,
            ctx,
            otx,
        );
        let transcript = std::env::temp_dir().join(format!("nest-session-test-{}.jsonl", uuid::Uuid::new_v4().simple()));
        let _opened = spawn(rt.clone(), agent.clone(), url, transcript, None, orx);
        // Nothing is connected yet: there is no host token. The request waits in the channel.
        let waiter = {
            let a = agent.clone();
            tokio::spawn(async move { a.resolve_hands_target(Duration::from_secs(10)).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        rt.host_token.send_replace(Some(Secret("tok".into())));
        match waiter.await.unwrap() {
            Ok(HandsOutcome::Ok { hands: t }) => assert_eq!(t, target),
            other => panic!("{other:?}"),
        }
        assert!(server.await.unwrap(), "AgentDO received the queued hands_resolve");
    }
}
