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
//! - A timed-out platform call is abandoned (`State::abandon`).

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
/// A connection that lasted this long was healthy: the reconnect backoff starts over after it.
pub const HEALTHY: Duration = Duration::from_secs(30);

/// Where an inbound reliable message stands against what this lineage has taken (`last_in`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InSeq {
    /// Taken already: ack again, apply nothing.
    Duplicate,
    /// The next one: take it.
    Next,
    /// A message is missing before it: take nothing, ack nothing, reconnect (the hello asks for
    /// everything past `last_in`, in order).
    Gap { expected: u64 },
}

/// The receiver's rule for one reliable seq. The lineage's first message (nothing taken yet) is
/// the baseline whatever its seq: AgentDO keeps its seq counter across a lineage reset. Pure.
pub fn classify(last_in: u64, seq: u64) -> InSeq {
    if last_in == 0 {
        InSeq::Next
    } else if seq <= last_in {
        InSeq::Duplicate
    } else if seq == last_in + 1 {
        InSeq::Next
    } else {
        InSeq::Gap { expected: last_in + 1 }
    }
}

/// The `seq` of a message this runner can't parse, if it has one: a reliable message of a type
/// (or shape) this release doesn't know. Skipping it would let the next seq's cumulative ack tell
/// AgentDO it was processed.
fn unparsed_seq(text: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(text).ok()?.get("seq")?.as_u64()
}

/// How long a closing session keeps trying to make everything durable.
pub const CLOSE_FLUSH: Duration = Duration::from_secs(30);

enum Step {
    Reconnect,
    Close,
}

/// Why a connection ended on a protocol error (it reconnects with a growing backoff).
#[derive(Debug)]
struct ProtocolError(String);

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

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

#[derive(Default)]
struct State {
    /// The last seq given to an outbound reliable message.
    last_out: u64,
    unacked: VecDeque<(u64, RunnerToAgent)>,
    last_in: u64,
    batch: Vec<AgentEvent>,
    /// Session bytes AgentDO reported durable.
    durable: u64,
    /// `hands_resolve` requests made while disconnected, sent right after the next `hello_ack`.
    resolves: Vec<model::RequestId>,
    /// Set by `Close`: give up at this instant.
    close_deadline: Option<tokio::time::Instant>,
    /// When the current (or last) connection's hello was acked.
    opened_at: Option<tokio::time::Instant>,
}

impl State {
    fn closing(&self) -> bool {
        self.close_deadline.is_some()
    }

    fn close_expired(&self) -> bool {
        self.close_deadline.is_some_and(|d| tokio::time::Instant::now() >= d)
    }

    fn close(&mut self) {
        self.close_deadline.get_or_insert(tokio::time::Instant::now() + CLOSE_FLUSH);
    }

    /// Give the next seq to a reliable message and keep it until AgentDO acks it.
    fn queue(&mut self, make: impl FnOnce(Seq) -> RunnerToAgent) -> &RunnerToAgent {
        self.last_out += 1;
        self.unacked.push_back((self.last_out, make(Seq(self.last_out))));
        &self.unacked.back().expect("just pushed").1
    }

    /// Abandon a timed-out platform call, keeping the seq lineage: an unacked copy becomes a
    /// `cancel_call` at its seq (a resend never runs it), and a fresh `cancel_call` covers one
    /// AgentDO already has. AgentDO handles cancels idempotently.
    fn abandon(&mut self, call: &model::CallId) -> RunnerToAgent {
        let reason = "timed out in the runner; the model was told the outcome is unknown".to_string();
        for (seq, m) in self.unacked.iter_mut() {
            if matches!(m, RunnerToAgent::ToolCall(tc) if &tc.call == call) {
                *m = RunnerToAgent::CancelCall { seq: Seq(*seq), call: call.clone(), reason: reason.clone() };
            }
        }
        self.queue(|seq| RunnerToAgent::CancelCall { seq, call: call.clone(), reason }).clone()
    }
}

impl Session {
    pub async fn run(mut self, mut out: mpsc::UnboundedReceiver<Outbound>) {
        let mut st = State::default();
        let mut backoff = Duration::from_millis(100);
        loop {
            st.opened_at = None;
            let r = self.connect_once(&mut st, &mut out).await;
            // The backoff starts over only after a connection that stayed up: a reconnect asked for
            // at once (AgentDO refused what was sent, a frame this release can't read) doesn't
            // turn into a reconnect loop at the first step's 100 ms.
            if st.opened_at.is_some_and(|t| t.elapsed() >= HEALTHY) {
                backoff = Duration::from_millis(100);
            }
            match r {
                Ok(Step::Close) => return,
                Ok(Step::Reconnect) => {}
                // A protocol error was logged where it was found.
                Err(e) if e.downcast_ref::<ProtocolError>().is_some() => {}
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
                        None => st.close(),
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
                st.queue(|seq| RunnerToAgent::ToolCall(ToolCall { seq, call, turn, name, arguments }));
            }
            Outbound::AbandonCall(call) => {
                st.abandon(&call);
            }
            Outbound::HandsResolve(req) => st.resolves.push(req),
            Outbound::ToolsListRequest(_) | Outbound::Reconnect => {}
            Outbound::SetTranscript(p) => self.tailer.set_path(p),
            Outbound::SetSession(s) => self.session = Some(s),
            Outbound::Close => st.close(),
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
                        None => st.close(),
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
            tools_changed: true,
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
        st.opened_at = Some(tokio::time::Instant::now());

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
                            Err(e) => match unparsed_seq(&t) {
                                // A reliable message this release can't read is never skipped: the
                                // next one's cumulative ack would say it was processed.
                                Some(seq) if seq > st.last_in => return Err(self.protocol_error(format!("can't read AgentDO's message {seq}: {e}")).into()),
                                Some(_) => continue, // one taken already
                                None => { tracing::warn!(agent = %self.agent.id, "skipping an AgentToRunner it can't read (no seq): {e}"); continue; }
                            },
                        };
                        match self.inbound(st, msg) {
                            Ok(Some(reply)) => tx.send(text(&reply)?).await?,
                            Ok(None) => {}
                            Err(e) => return Err(e.into()),
                        }
                    }
                    Some(Ok(Message::Ping(p))) => tx.send(Message::Pong(p)).await?,
                    Some(Ok(Message::Close(_))) | None => anyhow::bail!("session channel closed by peer"),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e.into()),
                },
                o = out.recv(), if !st.closing() => {
                    let Some(o) = o else {
                        st.close();
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
                            st.close();
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

    /// A protocol error on the session channel: logged, and reported to nestd (the channel can't go
    /// on past it, so the brain is stuck until it is fixed: an upgrade, AgentDO quarantining it).
    fn protocol_error(&self, message: String) -> ProtocolError {
        tracing::error!(agent = %self.agent.id, "session channel: {message}; reconnecting");
        self.report(message.clone());
        ProtocolError(message)
    }

    /// Tell nestd the session channel can't go on as it is (it logs it beside the brain's events).
    fn report(&self, message: String) {
        self.rt.report_for(
            &self.agent,
            nest_protocol::host::runner::RunnerEvent::Error {
                agent: Some(self.agent.id.clone()),
                error: model::ErrorBody { code: error_codes::INVALID_MESSAGE.into(), message: format!("session channel: {message}"), retryable: true },
            },
        );
    }

    /// Handle one inbound message; returns an immediate reply (acks), or a protocol error (a gap)
    /// that ends the connection.
    fn inbound(&mut self, st: &mut State, msg: AgentToRunner) -> Result<Option<RunnerToAgent>, ProtocolError> {
        let reliable_seq = match &msg {
            AgentToRunner::RunTurn { seq, .. }
            | AgentToRunner::Inbox { seq, .. }
            | AgentToRunner::Interrupt { seq, .. }
            | AgentToRunner::CacheUpdate { seq, .. }
            | AgentToRunner::ToolResult { seq, .. } => Some(seq.0),
            _ => None,
        };
        if let Some(seq) = reliable_seq {
            match classify(st.last_in, seq) {
                InSeq::Duplicate => return Ok(Some(RunnerToAgent::Ack { up_to: Seq(st.last_in) })),
                InSeq::Gap { expected } => return Err(self.protocol_error(format!("message {seq} arrived, {expected} expected"))),
                InSeq::Next => st.last_in = seq,
            }
        }
        let a = &self.agent;
        match msg {
            AgentToRunner::RunTurn { turn, input, .. } => a.command(AgentCmd::RunTurn { turn, input }),
            AgentToRunner::Inbox { message, .. } => a.command(AgentCmd::Inbox(message)),
            AgentToRunner::Interrupt { turn, .. } => a.command(AgentCmd::Interrupt { turn }),
            AgentToRunner::CacheUpdate { cache, .. } => a.set_cache(cache),
            AgentToRunner::ToolResult { call, outcome, .. } => a.resolve_call(&call, outcome),
            AgentToRunner::ToolsList { request, tools } => a.resolve_tools(&request, tools),
            AgentToRunner::ToolsChanged {} => a.tools_changed(),
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
                    // AgentDO refused what was sent; reconnecting resends it, so this repeats until
                    // either side changes: reported to nestd (logged just above), and paced by the
                    // reconnect backoff.
                    self.report(format!("AgentDO refused a message: {}", error.message));
                    a.send_out(Outbound::Reconnect);
                }
            }
        }
        Ok(reliable_seq.map(|_| RunnerToAgent::Ack { up_to: Seq(st.last_in) }))
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

/// Queue, then send: a send that fails (the usual way a broken socket shows) leaves the message
/// queued, so the next connection resends it under the same seq and AgentDO never sees a gap.
async fn send_reliable<S>(st: &mut State, tx: &mut S, make: impl FnOnce(Seq) -> RunnerToAgent) -> anyhow::Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let frame = text(st.queue(make))?;
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
        let mut st = State { batch: vec![ev(1, AgentEventBody::AssistantText { text: "x".into() })], ..State::default() };
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
        let mut st = State { last_out: 2, unacked: VecDeque::from([(1, tc(1)), (2, tc(2))]), ..State::default() };
        st.unacked[1].1 = RunnerToAgent::Events { seq: Seq(2), events: vec![] };
        let fresh = st.abandon(&call);
        // The unacked copy became a cancel at the same seq; a fresh cancel follows at the next seq.
        assert!(matches!(&st.unacked[0].1, RunnerToAgent::CancelCall { seq: Seq(1), call: c, .. } if c == &call));
        assert!(matches!(&fresh, RunnerToAgent::CancelCall { seq: Seq(3), .. }));
        let seqs: Vec<u64> = st.unacked.iter().map(|(s, _)| *s).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        assert_eq!(st.last_out, 3);
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
    /// The hello says the runner acts on `tools_changed`, and AgentDO's `tools_changed` reaches
    /// the agent's watchers (each `nest mcp` connection), so Claude Code is told to list again.
    #[tokio::test]
    async fn tools_changed_from_agentdo_reaches_the_mcp_bridge_watchers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_tc/session", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut wtx, mut wrx) = ws.split();
            while let Some(Ok(m)) = wrx.next().await {
                let Message::Text(t) = m else { continue };
                if let RunnerToAgent::Hello(h) = serde_json::from_str::<RunnerToAgent>(&t).unwrap() {
                    for m in [AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None }, AgentToRunner::ToolsChanged {}] {
                        wtx.send(Message::Text(serde_json::to_string(&m).unwrap().into())).await.unwrap();
                    }
                    // Keep the connection open until the runner side has seen it.
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    return h.tools_changed;
                }
            }
            false
        });
        let rt = Runtime::new(Config { batch_interval: Duration::from_millis(50), tail_interval: Duration::from_millis(50), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_tc".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        let mut watch = agent.watch_tools();
        let transcript = std::env::temp_dir().join(format!("nest-session-test-{}.jsonl", uuid::Uuid::new_v4().simple()));
        let _opened = spawn(rt.clone(), agent.clone(), url, transcript, None, orx);
        rt.host_token.send_replace(Some(Secret("tok".into())));
        tokio::time::timeout(Duration::from_secs(5), watch.changed()).await.expect("tools_changed reached the watcher").unwrap();
        assert!(server.await.unwrap(), "the hello advertised tools_changed");
    }
    #[test]
    fn the_receivers_seq_rule() {
        assert_eq!(classify(0, 57), InSeq::Next, "a lineage's first message is its baseline");
        assert_eq!(classify(5, 6), InSeq::Next);
        assert_eq!(classify(5, 5), InSeq::Duplicate);
        assert_eq!(classify(5, 1), InSeq::Duplicate);
        assert_eq!(classify(5, 7), InSeq::Gap { expected: 6 });
        assert_eq!(unparsed_seq(r#"{"type":"run_turn_v2","seq":4}"#), Some(4));
        assert_eq!(unparsed_seq(r#"{"type":"news"}"#), None);
        assert_eq!(unparsed_seq("not json"), None);
    }

    /// Audit R-B2: AgentDO answers a batch it can't take with `invalid_message` and keeps the socket;
    /// the runner reconnects and resends it, which repeats until a side changes. The reconnects are
    /// paced by a growing backoff (they used to run at 100 ms for the brain's life).
    #[tokio::test]
    async fn a_rejected_batch_reconnects_with_a_growing_backoff() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_p/session", listener.local_addr().unwrap());
        let hellos = Arc::new(AtomicUsize::new(0));
        let h = hellos.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let h = h.clone();
                tokio::spawn(async move {
                    let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                    let (mut wtx, mut wrx) = ws.split();
                    while let Some(Ok(m)) = wrx.next().await {
                        let Message::Text(t) = m else { continue };
                        let reply = match serde_json::from_str::<RunnerToAgent>(&t) {
                            Ok(RunnerToAgent::Hello(_)) => {
                                h.fetch_add(1, Ordering::SeqCst);
                                AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None }
                            }
                            Ok(RunnerToAgent::Events { .. }) => AgentToRunner::Error {
                                error: model::ErrorBody { code: error_codes::INVALID_MESSAGE.into(), message: "schema".into(), retryable: false },
                            },
                            _ => continue,
                        };
                        if wtx.send(Message::Text(serde_json::to_string(&reply).unwrap().into())).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        let rt = Runtime::new(Config { batch_interval: Duration::from_millis(50), tail_interval: Duration::from_millis(50), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_p".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        let transcript = std::env::temp_dir().join(format!("nest-probe-{}.jsonl", uuid::Uuid::new_v4().simple()));
        let _opened = spawn(rt.clone(), agent.clone(), url, transcript, None, orx);
        rt.host_token.send_replace(Some(Secret("tok".into())));
        agent.emit(model::AgentEventBody::AssistantText { text: "x".into() });
        tokio::time::sleep(Duration::from_secs(3)).await;
        let n = hellos.load(Ordering::SeqCst);
        // 100, 200, 400, 800 and 1600 ms apart: at most 6 in 3 s (it was about 30).
        assert!((2..=6).contains(&n), "{n} session hellos in 3 s");
    }
    /// A seq that skips one (a message lost or reordered) is never taken or acked: the runner
    /// reconnects, and its hello asks for everything past the last one it took.
    #[tokio::test]
    async fn a_gap_is_never_acked_past() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_g/session", listener.local_addr().unwrap());
        // Two connections: on the first, seq 1 then 3 (2 missing); on the second, the hello's
        // last_seq, then 2 and 3 resent in order.
        let server = tokio::spawn(async move {
            let mut out: Vec<(Option<u64>, Vec<u64>)> = Vec::new();
            for conn in 0..2 {
                let (tcp, _) = listener.accept().await.unwrap();
                let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
                let (mut wtx, mut wrx) = ws.split();
                let (mut hello_last, mut acks) = (None, Vec::new());
                let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                loop {
                    let m = tokio::select! {
                        m = wrx.next() => m,
                        _ = tokio::time::sleep_until(deadline) => break,
                    };
                    let t = match m {
                        Some(Ok(Message::Text(t))) => t,
                        Some(Ok(_)) => continue,
                        _ => break,
                    };
                    match serde_json::from_str::<RunnerToAgent>(&t) {
                        Ok(RunnerToAgent::Hello(h)) => {
                            hello_last = h.last_seq.map(|s| s.0);
                            let ack = AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None };
                            wtx.send(Message::Text(serde_json::to_string(&ack).unwrap().into())).await.unwrap();
                            let seqs: &[u64] = if conn == 0 { &[1, 3] } else { &[2, 3] };
                            for seq in seqs {
                                wtx.send(Message::Text(format!(r#"{{"type":"interrupt","seq":{seq}}}"#).into())).await.unwrap();
                            }
                        }
                        Ok(RunnerToAgent::Ack { up_to }) => {
                            acks.push(up_to.0);
                            if conn == 1 && up_to.0 == 3 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                out.push((hello_last, acks));
            }
            out
        });
        let rt = Runtime::new(Config { batch_interval: Duration::from_millis(50), tail_interval: Duration::from_millis(50), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_g".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        let transcript = std::env::temp_dir().join(format!("nest-probe-{}.jsonl", uuid::Uuid::new_v4().simple()));
        let _opened = spawn(rt.clone(), agent.clone(), url, transcript, None, orx);
        rt.host_token.send_replace(Some(Secret("tok".into())));
        let conns = server.await.unwrap();
        assert_eq!(conns[0].1, [1], "seq 1 taken, nothing past the gap: {conns:?}");
        assert_eq!(conns[1].0, Some(1), "the reconnect asks for everything past 1: {conns:?}");
        assert_eq!(conns[1].1, [2, 3], "then takes 2 and 3 in order: {conns:?}");
        // nestd was told.
        let (_, ev) = rt.to_nestd_rx.lock().await.try_recv().expect("a report to nestd");
        assert!(matches!(ev, nest_protocol::host::runner::RunnerEvent::Error { error, .. } if error.code == error_codes::INVALID_MESSAGE && error.message.contains("3 arrived, 2 expected")));
    }

    /// Audit R-B1: a reliable message this runner can't read (a newer Worker's variant) used to be
    /// skipped, and the next seq's cumulative ack told AgentDO it was processed. It is a protocol
    /// error now: nothing past it is taken or acked, and the runner reconnects.
    #[tokio::test]
    async fn a_reliable_message_it_cant_read_is_never_acked_past() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_u/session", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let (mut wtx, mut wrx) = ws.split();
            let mut acks = Vec::new();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            loop {
                let m = tokio::select! {
                    m = wrx.next() => m,
                    _ = tokio::time::sleep_until(deadline) => break,
                };
                let t = match m {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(_)) => continue,
                    _ => break,
                };
                match serde_json::from_str::<RunnerToAgent>(&t) {
                    Ok(RunnerToAgent::Hello(_)) => {
                        let ack = AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None };
                        wtx.send(Message::Text(serde_json::to_string(&ack).unwrap().into())).await.unwrap();
                        // A variant this release can't parse, then a known one.
                        wtx.send(Message::Text(r#"{"type":"run_turn_v2","seq":1}"#.to_string().into())).await.unwrap();
                        wtx.send(Message::Text(r#"{"type":"interrupt","seq":2}"#.to_string().into())).await.unwrap();
                    }
                    Ok(RunnerToAgent::Ack { up_to }) => acks.push(up_to.0),
                    _ => {}
                }
            }
            acks
        });
        let rt = Runtime::new(Config { batch_interval: Duration::from_millis(50), tail_interval: Duration::from_millis(50), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let agent = Agent::new(AgentId("agt_u".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        let transcript = std::env::temp_dir().join(format!("nest-probe-{}.jsonl", uuid::Uuid::new_v4().simple()));
        let _opened = spawn(rt.clone(), agent.clone(), url, transcript, None, orx);
        rt.host_token.send_replace(Some(Secret("tok".into())));
        let acks = server.await.unwrap();
        assert!(acks.is_empty(), "nothing past the message it can't read is acked: {acks:?}");
    }
}
