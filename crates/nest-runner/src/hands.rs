//! Hands for the runner: one gateway WebSocket per tool call, through `nest-hands-client`.
//!
//! The runner never sees a vsock socket. It asks AgentDO for the target (gateway URL, binding,
//! guest version) over its session channel (`hands_resolve`): before the first call, shortly
//! before the binding expires, and whenever a gateway refuses the target
//! (`nest_hands_client::Next`). MCP arguments go verbatim, `HandsResult` content maps 1:1 to MCP
//! content. Cancelling sends `cancel`, then hangs up if the guest doesn't answer promptly.

use std::sync::Arc;
use std::time::{Duration, Instant};

use nest_hands_client::{HandsConn, NOT_READY_RETRY, Next, OpenError, OpenOptions, RecvError, Wait, guest_error_next};
use nest_protocol::gateway::HandsTarget;
use nest_protocol::guest::{HandsCancel, HandsOp, HandsRequest, HandsResponse, HandsResult, ToolContent};
use nest_protocol::host::mcp::{McpContent, ToolCallResult};
use nest_protocol::model::{Epoch, ErrorBody};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::runtime::{Agent, ResolveTimeout};
use nest_protocol::model::error_codes::OUTCOME_UNKNOWN;
use nest_protocol::control::HandsOutcome;

/// How long to wait for the guest's final frame after sending `cancel`.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);
/// `hands_resolved.error.code` for "ask again later" (docs/interfaces/control-host/session/).
pub const SANDBOX_NOT_READY: &str = "sandbox_not_ready";

/// Wall-clock bounds of one call's setup. Every wait is capped to what is left of its budget
/// and to `max_sleep`, so a hint like `retry_after_ms: 600000` can never park a call.
#[derive(Clone, Debug)]
pub struct Budgets {
    /// One `hands_resolve` round trip over the session channel.
    pub resolve_timeout: Duration,
    /// Total wait while AgentDO answers `sandbox_not_ready` (placing, waking, a slot pending).
    pub not_ready: Duration,
    /// Total wait while the gateway answers `busy` (guest not configured, a resync, vsock down),
    /// the guest answers its own `busy`, or a bind times out: short, so a wedged guest fails a
    /// call promptly.
    pub busy: Duration,
    /// Total wait, instead, once the gateway has answered `busy` with reason `paused` in this call
    /// (nestd has the VM paused for a commit, which ends on its own). Covers a checkpoint's
    /// pause: on 2026-11-02 one 32 GiB disk's held its VM paused 33-39 s.
    pub paused: Duration,
    /// The longest single sleep, whatever a `retry_after_ms` hint says.
    pub max_sleep: Duration,
    /// The pause before resolving again after an HTTP 5xx from in front of the gateway (a
    /// tunnel that is reconnecting answers 530 for a few seconds); at most `max_sleep`.
    pub edge_pause: Duration,
    pub open: OpenOptions,
}

impl Default for Budgets {
    fn default() -> Self {
        Budgets {
            resolve_timeout: Duration::from_secs(10),
            not_ready: Duration::from_secs(60),
            busy: Duration::from_secs(30),
            paused: Duration::from_secs(120),
            max_sleep: Duration::from_secs(10),
            edge_pause: Duration::from_secs(2),
            open: OpenOptions::default(),
        }
    }
}

/// Build the RPC op from an MCP `tools/call` (`name` is the bare tool name, e.g. `Bash`).
pub fn op_from_mcp(name: &str, arguments: &Value) -> Result<HandsOp, String> {
    let mut v = match arguments {
        Value::Object(m) => Value::Object(m.clone()),
        Value::Null => Value::Object(Default::default()),
        _ => return Err("arguments must be an object".into()),
    };
    v["tool"] = Value::String(name.to_string());
    serde_json::from_value(v).map_err(|e| format!("invalid arguments for {name}: {e}"))
}

/// Execute one hands call for `agent` with the default [`Budgets`]. Never fails at the Rust
/// level: errors become MCP error results. The caller has checked that the agent has hands.
pub async fn call(agent: &Arc<Agent>, call_id: String, op: HandsOp, cancel: CancellationToken) -> ToolCallResult {
    call_with(agent, call_id, op, &cancel, &Budgets::default()).await
}

/// Fetch the target in the background right after `agent_start`, so the first tool call finds
/// it cached. Waits through `sandbox_not_ready` like a call would.
pub fn prefetch_target(agent: Arc<Agent>) {
    if agent.hands.is_none() {
        return;
    }
    tokio::spawn(async move {
        // Ends with the brain, not with an interrupt's hands cancel.
        if let Err(r) = ensure_target(&agent, &agent.cancel.child_token(), &Budgets::default()).await {
            tracing::info!(agent = %agent.id, "hands target not prefetched: {}", r.content.first().map(|c| format!("{c:?}")).unwrap_or_default());
        }
    });
}

/// [`call`] with explicit budgets.
pub async fn call_with(
    agent: &Arc<Agent>,
    call_id: String,
    op: HandsOp,
    cancel: &CancellationToken,
    budgets: &Budgets,
) -> ToolCallResult {
    let mut retries = Retries { re_resolved: false, busy_since: None, paused_seen: false };
    loop {
        let (mut conn, epoch, generation) = match connect(agent, cancel, budgets, &mut retries).await {
            Ok(c) => c,
            Err(r) => return r,
        };
        let req = HandsRequest {
            protocol_version: conn.guest().protocol_version,
            call_id: call_id.clone(),
            agent_id: agent.id.clone(),
            epoch,
            op: op.clone(),
        };
        match conn.send_json(&req).await {
            Ok(()) => {}
            // Refused before any byte left (the request does not fit a frame).
            Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => return ToolCallResult::error(format!("hands request failed: {e}")),
            // Part of the frame may have left: the guest may run it.
            Err(e) => return unknown_outcome(&format!("sending the request failed ({e})")),
        }
        let outcome = exchange(agent, &mut conn, generation, cancel).await;
        tokio::spawn(conn.close());
        match outcome {
            Exchange::Done(r) => return r,
            // Refused before anything ran (e.g. a guest not configured yet): the same
            // policy and budget as the gateway's `busy`.
            Exchange::GuestBusy(error, after) => {
                if let Err(r) = busy_wait(&mut retries, after, Wait::Busy, budgets, cancel, &error.message).await {
                    return r;
                }
            }
        }
    }
}

/// What one call's setup has spent: the one re-resolve, when the first `busy` came, and whether
/// the gateway has said the VM is paused.
struct Retries {
    re_resolved: bool,
    busy_since: Option<Instant>,
    /// A `paused` busy was seen: the call waits within [`Budgets::paused`] from then on, so the
    /// moment the pause ends (the guest answering slowly just after) doesn't cut it short.
    paused_seen: bool,
}

/// Wait out a `busy` (gateway or guest) within [`Budgets::busy`], or [`Budgets::paused`] once
/// the call has met a paused VM; the error result once spent.
async fn busy_wait(
    retries: &mut Retries,
    after: Duration,
    wait: Wait,
    budgets: &Budgets,
    cancel: &CancellationToken,
    message: &str,
) -> Result<(), ToolCallResult> {
    let since = *retries.busy_since.get_or_insert_with(Instant::now);
    retries.paused_seen |= wait == Wait::Paused;
    let budget = if retries.paused_seen { budgets.paused } else { budgets.busy };
    let Some(wait) = capped(after, since, budget, budgets.max_sleep) else {
        // The last refusal's message says why, e.g. "the sandbox is paused: checkpoint (turn_end)".
        let what = if retries.paused_seen { "stayed paused" } else { "stayed busy" };
        return Err(ToolCallResult::error(format!("hands unavailable: the sandbox {what} for {}s (last: {message})", budget.as_secs())));
    };
    if sleep_or_cancel(wait, cancel).await {
        return Err(ToolCallResult::error("interrupted"));
    }
    Ok(())
}

/// A bound connection for this call, per [`OpenError::next`]: `busy` waits, a refusal a fresh
/// target may cure resolves again once, anything else is the error result.
async fn connect(
    agent: &Arc<Agent>,
    cancel: &CancellationToken,
    budgets: &Budgets,
    retries: &mut Retries,
) -> Result<(HandsConn, Epoch, u64), ToolCallResult> {
    loop {
        let (target, generation) = ensure_target(agent, cancel, budgets).await?;
        // A bind may take the whole bind timeout (a frozen guest behind a gateway that can't
        // tell); an interrupt doesn't wait for it.
        let opened = tokio::select! {
            r = nest_hands_client::open(&target, &budgets.open) => r,
            _ = cancel.cancelled() => return Err(ToolCallResult::error("interrupted")),
        };
        let e = match opened {
            // The epoch every request carries is the binding's, the one the gateway checks.
            Ok(c) => match c.epoch() {
                Some(epoch) => return Ok((c, epoch, generation)),
                None => {
                    agent.drop_target_if(generation);
                    return Err(ToolCallResult::error("hands unavailable: the target's binding does not parse"));
                }
            },
            Err(e) => e,
        };
        match e.next() {
            Next::RetrySame { after, wait } => {
                let msg = match &e {
                    OpenError::Refused(r) => r.message.clone(),
                    OpenError::Timeout(_) => format!(
                        "the gateway took the bind but answered nothing within {}s: the guest is paused or slow",
                        budgets.open.bind_timeout.as_secs()
                    ),
                    other => other.to_string(),
                };
                busy_wait(retries, after, wait, budgets, cancel, &msg).await?;
            }
            next => {
                // Whatever refused this target, it is not worth keeping: the next call fetches
                // a fresh one. Refusals a fresh target may cure get one retry in this call.
                agent.drop_target_if(generation);
                if next == Next::Resolve && !retries.re_resolved {
                    tracing::info!(agent = %agent.id, "hands target refused ({e}); resolving again");
                    retries.re_resolved = true;
                    if edge_outage(&e) && sleep_or_cancel(budgets.edge_pause.min(budgets.max_sleep), cancel).await {
                        return Err(ToolCallResult::error("interrupted"));
                    }
                    continue;
                }
                return Err(ToolCallResult::error(format!("hands unavailable: {e}")));
            }
        }
    }
}

enum Exchange {
    Done(ToolCallResult),
    /// The guest refused the request as `busy`; nothing ran. Retry after the pause.
    GuestBusy(ErrorBody, Duration),
}

/// Read the guest's answer to the request just sent, honoring a cancel.
async fn exchange(agent: &Arc<Agent>, conn: &mut HandsConn, generation: u64, cancel: &CancellationToken) -> Exchange {
    let mut cancelled = false;
    let mut cancel_sent = false;
    let outcome = loop {
        if cancelled && !cancel_sent {
            cancel_sent = true;
            let _ = conn.send_json(&HandsCancel::Cancel {}).await;
        }
        let next = if cancelled {
            match tokio::time::timeout(CANCEL_GRACE, conn.recv_json::<HandsResponse>()).await {
                Ok(r) => r,
                Err(_) => break ToolCallResult::error("interrupted"),
            }
        } else {
            tokio::select! {
                r = conn.recv_json::<HandsResponse>() => r,
                _ = cancel.cancelled() => {
                    cancelled = true;
                    continue;
                }
            }
        };
        match next {
            Ok(Some(HandsResponse::Started { .. })) => continue,
            Ok(Some(HandsResponse::Result { result, .. })) => break to_mcp(result),
            Ok(Some(HandsResponse::Error { error, .. })) if !cancelled => match guest_error_next(&error) {
                Next::RetrySame { after, .. } => return Exchange::GuestBusy(error, after),
                _ => break error_result(&error),
            },
            Ok(Some(HandsResponse::Error { error, .. })) => break error_result(&error),
            Ok(None) if cancelled => break ToolCallResult::error("interrupted"),
            // The request was sent: a close or a broken connection before the result (a guest
            // EOF, a gateway restart) leaves the command possibly run.
            Ok(None) => break unknown_outcome("the connection closed before a result arrived"),
            Err(RecvError::Closed(c)) if c.is_moved() => {
                agent.drop_target_if(generation);
                break unknown_outcome(&format!("the sandbox left its host while the call ran ({c})"));
            }
            Err(RecvError::Closed(c)) if c.is_unauthorized() => {
                agent.drop_target_if(generation);
                break ToolCallResult::error(format!("hands refused: {c}"));
            }
            Err(e) if cancelled => break ToolCallResult::error(format!("interrupted ({e})")),
            Err(e) => break unknown_outcome(&format!("the connection failed before a result arrived ({e})")),
        }
    };
    Exchange::Done(outcome)
}

/// After the request frame went out, losing the connection says nothing about the command.
fn unknown_outcome(why: &str) -> ToolCallResult {
    ToolCallResult::error(format!(
        "{OUTCOME_UNKNOWN}: {why}; the call may or may not have taken effect. Check before retrying anything with side \
         effects."
    ))
}

/// An HTTP 5xx from in front of the gateway: the next resolve waits `Budgets::edge_pause` first.
fn edge_outage(e: &OpenError) -> bool {
    matches!(e, OpenError::Transport(t) if t.is_edge_outage())
}

/// How long to actually sleep for a `wait` hint: at most `max`, at most what is left of
/// `budget` since `started`; `None` once the budget is spent.
fn capped(wait: Duration, started: Instant, budget: Duration, max: Duration) -> Option<Duration> {
    let left = budget.checked_sub(started.elapsed())?;
    if left.is_zero() {
        return None;
    }
    Some(wait.min(max).min(left))
}

/// The cached target, or one fetched from AgentDO; waits through `sandbox_not_ready`. One
/// caller at a time fetches; the others find what it stored.
async fn ensure_target(
    agent: &Arc<Agent>,
    cancel: &CancellationToken,
    budgets: &Budgets,
) -> Result<(HandsTarget, u64), ToolCallResult> {
    if let Some(t) = agent.hands_target() {
        return Ok(t);
    }
    let _gate = tokio::select! {
        g = agent.resolve_gate.lock() => g,
        _ = cancel.cancelled() => return Err(ToolCallResult::error("interrupted")),
    };
    if let Some(t) = agent.hands_target() {
        return Ok(t);
    }
    let started = Instant::now();
    loop {
        let outcome = tokio::select! {
            r = agent.resolve_hands_target(budgets.resolve_timeout) => r,
            _ = cancel.cancelled() => return Err(ToolCallResult::error("interrupted")),
        };
        match outcome {
            Ok(HandsOutcome::Ok { hands: t }) => return Ok((t.clone(), agent.set_hands_target(t))),
            Ok(HandsOutcome::Error { error, retry_after_ms }) if error.code == SANDBOX_NOT_READY && error.retryable => {
                let wait = retry_after_ms.map(Duration::from_millis).unwrap_or(NOT_READY_RETRY);
                let Some(wait) = capped(wait, started, budgets.not_ready, budgets.max_sleep) else {
                    return Err(not_ready_error(budgets, &error.message));
                };
                if sleep_or_cancel(wait, cancel).await {
                    return Err(ToolCallResult::error("interrupted"));
                }
                if started.elapsed() >= budgets.not_ready {
                    return Err(not_ready_error(budgets, &error.message));
                }
            }
            Ok(HandsOutcome::Error { error, .. }) => return Err(error_result(&error)),
            Err(ResolveTimeout) => {
                return Err(ToolCallResult::error(format!(
                    "hands unavailable: AgentDO did not answer hands_resolve within {}s",
                    budgets.resolve_timeout.as_secs()
                )));
            }
        }
    }
}

fn not_ready_error(budgets: &Budgets, message: &str) -> ToolCallResult {
    ToolCallResult::error(format!(
        "hands unavailable: the sandbox was not ready for {}s ({message})",
        budgets.not_ready.as_secs()
    ))
}

/// Sleep `d`; true if the call was cancelled meanwhile.
async fn sleep_or_cancel(d: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = cancel.cancelled() => true,
    }
}

/// Guest result → MCP result (1:1 content).
pub fn to_mcp(r: HandsResult) -> ToolCallResult {
    ToolCallResult {
        content: r
            .content
            .into_iter()
            .map(|c| match c {
                ToolContent::Text { text } => McpContent::Text { text },
                ToolContent::Image { media_type, data_b64 } => McpContent::Image { data: data_b64, mime_type: media_type },
            })
            .collect(),
        is_error: r.is_error,
    }
}

pub fn error_result(e: &ErrorBody) -> ToolCallResult {
    ToolCallResult::error(format!("{}: {}", e.code, e.message))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{AgentCmd, Outbound};
    use crate::test_support::FakeGuest;
    use crate::test_support::gateway::TestGateway;
    use nest_protocol::control::HandsBinding;
    use nest_protocol::model::{AgentId, Epoch, SandboxId, error_codes};
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    const SBX: &str = "sbx_t";
    const AGENT: &str = "agt_t";
    /// Generous bound for anything that should be prompt (a loaded CI runner included).
    const SOON: Duration = Duration::from_secs(10);

    #[test]
    fn op_from_mcp_tags_tool() {
        match op_from_mcp("Bash", &json!({"command": "ls", "timeout": 5000})).unwrap() {
            HandsOp::Bash(b) => assert_eq!((b.command.as_str(), b.timeout), ("ls", Some(5000))),
            o => panic!("{o:?}"),
        }
        assert!(op_from_mcp("Read", &json!({})).is_err(), "file_path required");
        assert!(op_from_mcp("Nope", &json!({})).is_err());
    }

    #[test]
    fn capped_sleeps_never_exceed_the_budget_or_the_cap() {
        let started = Instant::now();
        let budget = Duration::from_secs(30);
        let max = Duration::from_secs(10);
        // A hint of ten minutes sleeps the cap, not the hint.
        assert_eq!(capped(Duration::from_secs(600), started, budget, max), Some(max));
        // A short hint sleeps the hint.
        assert_eq!(capped(Duration::from_millis(50), started, budget, max), Some(Duration::from_millis(50)));
        // What is left of the budget bounds everything.
        let late = Instant::now() - Duration::from_secs(29);
        assert!(capped(Duration::from_secs(600), late, budget, max).unwrap() <= Duration::from_secs(1));
        let spent = Instant::now() - Duration::from_secs(31);
        assert_eq!(capped(Duration::from_millis(1), spent, budget, max), None);
    }

    /// An agent whose `hands_resolve` requests a scripted "AgentDO" answers in order; the last
    /// answer repeats; `None` answers never arrive. Returns the agent and the resolve counter.
    fn agent_with_resolver(answers: Vec<Option<HandsOutcome>>) -> (Arc<Agent>, Arc<Mutex<usize>>) {
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel::<AgentCmd>();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
        let agent = Agent::new(
            AgentId(AGENT.into()),
            Epoch(4),
            std::env::temp_dir(),
            Some(HandsBinding { sandbox: SandboxId(SBX.into()), epoch: None }),
            vec![],
            0,
            cmd_tx,
            out_tx,
        );
        let resolves = Arc::new(Mutex::new(0usize));
        let (a2, r2) = (agent.clone(), resolves.clone());
        let mut answers: VecDeque<Option<HandsOutcome>> = answers.into();
        tokio::spawn(async move {
            while let Some(o) = out_rx.recv().await {
                if let Outbound::HandsResolve(req) = o {
                    *r2.lock().unwrap() += 1;
                    let answer = if answers.len() > 1 {
                        answers.pop_front().unwrap()
                    } else {
                        answers.front().and_then(|a| a.clone())
                    };
                    if let Some(answer) = answer {
                        a2.resolve_hands(&req, answer);
                    }
                }
            }
        });
        (agent, resolves)
    }

    fn target(t: HandsTarget) -> Option<HandsOutcome> {
        Some(HandsOutcome::Ok { hands: t })
    }

    fn bash(cmd: &str) -> HandsOp {
        op_from_mcp("Bash", &json!({"command": cmd})).unwrap()
    }

    fn quick() -> Budgets {
        Budgets {
            resolve_timeout: Duration::from_millis(300),
            not_ready: Duration::from_millis(600),
            busy: Duration::from_millis(600),
            paused: Duration::from_millis(1500),
            max_sleep: Duration::from_millis(100),
            edge_pause: Duration::from_millis(50),
            open: OpenOptions { connect_timeout: Duration::from_millis(300), bind_timeout: Duration::from_secs(5) },
        }
    }

    /// A plain HTTP server answering every request with `status` and no upgrade: Cloudflare's
    /// edge in front of a tunnel hostname with no connector behind it.
    async fn http_status_server(status: u16) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                    }
                    let reply = format!("HTTP/1.1 {status} Edge\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    let _ = stream.write_all(reply.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        url
    }

    async fn gateway_with_guest() -> (TestGateway, FakeGuest) {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox(SBX, 4, &guest.path, &[AGENT]);
        (gw, guest)
    }

    /// Wait until the guest has seen `n` requests.
    async fn guest_saw(guest: &FakeGuest, n: usize) {
        let deadline = Instant::now() + SOON;
        while guest.requests().await.len() < n {
            assert!(Instant::now() < deadline, "the guest never saw request {n}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn text_of(r: &ToolCallResult) -> String {
        format!("{r:?}")
    }

    #[tokio::test]
    async fn resolves_once_then_calls_and_cancels_through_the_gateway() {
        let (gw, guest) = gateway_with_guest().await;
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(r.content, vec![McpContent::Text { text: "ran: echo hi".into() }]);
        let seen = guest.requests().await;
        assert_eq!((seen[0].call_id.as_str(), seen[0].epoch, seen[0].agent_id.0.as_str()), ("c1", Epoch(4), AGENT));

        // A second call reuses the cached target: no new resolve.
        let rx = CancellationToken::new();
        let r = call(&agent, "c2".into(), bash("echo again"), rx).await;
        assert!(!r.is_error);
        assert_eq!(*resolves.lock().unwrap(), 1, "the target is cached across calls");

        // `sleep` blocks in the fake until cancelled.
        let tx = CancellationToken::new();
        let rx = tx.clone();
        let a2 = agent.clone();
        let h = tokio::spawn(async move { call(&a2, "c3".into(), bash("sleep 30"), rx).await });
        guest_saw(&guest, 3).await;
        let cancelled_at = Instant::now();
        tx.cancel();
        let r = h.await.unwrap();
        assert!(r.is_error);
        assert!(guest.cancelled().await.contains(&"c3".to_string()), "the guest saw the cancel");
        // The `cancel` frame reached the guest; only a hangup after CANCEL_GRACE would take longer.
        assert!(cancelled_at.elapsed() < CANCEL_GRACE / 2, "cancel took {:?}", cancelled_at.elapsed());
    }

    #[tokio::test]
    async fn a_stale_binding_is_resolved_again_exactly_once() {
        let (gw, guest) = gateway_with_guest().await;
        // First answer: a binding for epoch 3, which the gateway (at epoch 4) refuses as stale.
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 3, AGENT)), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
        assert_eq!(guest.requests().await[0].epoch, Epoch(4));

        // Two stale answers in a row: one re-resolve, then an error result, never a loop; and
        // the refused target is not kept for the next call.
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 3, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c2".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("stale_epoch"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
        assert!(agent.hands_target().is_none());
    }

    #[tokio::test]
    async fn an_expired_binding_is_resolved_again_once() {
        let (gw, guest) = gateway_with_guest().await;
        let expired = gw.target_with_exp(SBX, 4, AGENT, 1_000);
        let (agent, resolves) = agent_with_resolver(vec![target(expired), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "unauthorized (expired) resolves again once");
        assert_eq!(guest.requests().await.len(), 1);
    }

    #[tokio::test]
    async fn a_target_with_a_stale_guest_version_is_resolved_again_once() {
        // SandboxDO minted the target before it heard the guest was upgraded: the gateway
        // refuses the bind as `unsupported_version`; the fresh target carries the current one.
        let (gw, guest) = gateway_with_guest().await;
        let mut stale = gw.target(SBX, 4, AGENT);
        stale.guest.protocol_version += 1;
        let (agent, resolves) = agent_with_resolver(vec![target(stale.clone()), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
        assert_eq!(guest.requests().await.len(), 1);

        // Still stale after the re-resolve: an error result, never a loop.
        let (agent, resolves) = agent_with_resolver(vec![target(stale)]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c2".into(), bash("echo hi"), rx).await;
        assert!(text_of(&r).contains("unsupported_version"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn a_target_is_resolved_again_shortly_before_its_binding_expires() {
        let (gw, guest) = gateway_with_guest().await;
        let soon = crate::runtime::now_ms() + 30_000;
        assert!(Duration::from_secs(30) < nest_hands_client::REFRESH_MARGIN);
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target_with_exp(SBX, 4, AGENT, soon)), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo one"), rx).await;
        assert!(!r.is_error, "{r:?}");
        // The cached binding has 30 s left, inside the margin: the next call resolves first
        // instead of finding out from a refused bind.
        let rx = CancellationToken::new();
        let r = call(&agent, "c2".into(), bash("echo two"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
        assert_eq!(guest.requests().await.len(), 2);
        // A target with an hour left stays cached.
        let rx = CancellationToken::new();
        let r = call(&agent, "c3".into(), bash("echo three"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn the_guests_busy_is_retried_like_the_gateways() {
        let (gw, guest) = gateway_with_guest().await;
        guest.refuse_busy(2).await;
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(r.content, vec![McpContent::Text { text: "ran: echo hi".into() }]);
        let seen = guest.requests().await;
        assert_eq!(seen.len(), 3, "two refusals, then the call ran");
        assert!(seen.iter().all(|r| r.call_id == "c1"), "the same call each time");
        assert_eq!(*resolves.lock().unwrap(), 1, "busy keeps the target");

        // Within the same wall-clock budget.
        guest.refuse_busy(usize::MAX).await;
        let rx = CancellationToken::new();
        let started = Instant::now();
        let r = call_with(&agent, "c2".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(text_of(&r).contains("stayed busy") && text_of(&r).contains("not configured"), "{r:?}");
        assert!(started.elapsed() < quick().busy + Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_host_that_never_answers_is_resolved_again_once() {
        let (gw, _guest) = gateway_with_guest().await;
        // A listener that accepts the TCP connect (into its backlog) but never completes the
        // upgrade: a dead sandbox host as the runner sees it.
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut stuck = gw.target(SBX, 4, AGENT);
        stuck.url = format!("ws://{}", dead.local_addr().unwrap());
        let (agent, resolves) = agent_with_resolver(vec![target(stuck), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "a connect timeout resolves again once");
        drop(dead);
    }

    #[tokio::test]
    async fn busy_is_retried_until_the_guest_is_configured() {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        // Registered without guest info: the gateway answers `busy`.
        gw.add_sandbox_booting(SBX, 4, &guest.path, &[AGENT]);
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let gw2 = gw.state.clone();
        let path = guest.path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            TestGateway::configure(&gw2, SBX, 4, &path, &[AGENT]);
        });
        let rx = CancellationToken::new();
        let started = Instant::now();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert!(started.elapsed() >= Duration::from_millis(500), "the first attempt was refused as busy");
    }

    #[tokio::test]
    async fn the_busy_budget_is_a_wall_clock_bound() {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox_booting(SBX, 4, &guest.path, &[AGENT]);
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("stayed busy"), "{r:?}");
        assert!(started.elapsed() < quick().busy + Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    /// The defaults: a checkpoint's pause as the incident of 2026-11-02 saw it (39 s, 32 GiB), with
    /// a full bind timeout and a pause hint on top, fits the paused budget; every other `busy`
    /// keeps the 30 s it had, so a wedged guest fails a call in 30 s, not 120 s.
    #[test]
    fn the_default_budgets_cover_a_checkpoints_pause_and_keep_30_s_for_other_busy() {
        use nest_protocol::gateway::{CLIENT_BIND_TIMEOUT_MS, PAUSED_RETRY_AFTER_MS};
        let b = Budgets::default();
        let incident_pause = Duration::from_secs(40);
        let slack = Duration::from_millis(CLIENT_BIND_TIMEOUT_MS) + Duration::from_millis(PAUSED_RETRY_AFTER_MS);
        assert!(b.paused >= incident_pause + slack, "paused {:?}", b.paused);
        assert_eq!(b.busy, Duration::from_secs(30));
        assert_eq!(b.open.bind_timeout, Duration::from_millis(CLIENT_BIND_TIMEOUT_MS));
        assert!(b.max_sleep <= Duration::from_secs(10), "a pause hint never parks a call for long");
    }

    /// Budgets far enough apart that a wall clock tells which one ended a call: `busy` 1 s,
    /// `paused` 4 s (the defaults' 30 s and 120 s, scaled).
    fn split() -> Budgets {
        Budgets { busy: Duration::from_secs(1), paused: Duration::from_secs(4), ..quick() }
    }

    /// A call that meets a paused VM (the gateway's `busy` with reason `paused`) waits it out
    /// within the paused budget, past the busy one, and runs once the VM runs again: the
    /// incident's call, scaled (a 2 s pause, between the 1 s and 4 s budgets).
    #[tokio::test]
    async fn a_call_waits_out_a_checkpoints_pause_past_the_busy_budget_then_runs() {
        let (gw, guest) = gateway_with_guest().await;
        guest.freeze(true).await;
        gw.set_paused(SBX, 4, &guest.path, &[AGENT], Some("checkpoint (turn_end)"));
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let (state, path) = (gw.state.clone(), guest.path.clone());
        let pause = Duration::from_secs(2);
        assert!(split().busy < pause && pause < split().paused);
        let g2 = guest.log_handle();
        tokio::spawn(async move {
            tokio::time::sleep(pause).await;
            g2.lock().await.frozen = false;
            TestGateway::configure(&state, SBX, 4, &path, &[AGENT]);
        });
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &CancellationToken::new(), &split()).await;
        assert!(!r.is_error, "{r:?}");
        assert!(started.elapsed() >= pause, "it ran only after the pause: {:?}", started.elapsed());
        assert_eq!(guest.requests().await.len(), 1, "once, after the pause");
        assert_eq!(*resolves.lock().unwrap(), 1, "busy keeps the target");
    }

    /// The long budget sticks: once a call has met a paused VM, a plain `busy` after it (the VM
    /// running again, its guest not answering yet) keeps the paused budget, so the end of a pause
    /// doesn't cut the call short. Scaled: paused 0.5 s, then a plain `busy` until 2.5 s, past the
    /// 1 s busy budget and inside the 4 s paused one.
    #[tokio::test]
    async fn a_plain_busy_after_a_pause_keeps_the_paused_budget() {
        let (gw, guest) = gateway_with_guest().await;
        gw.set_paused(SBX, 4, &guest.path, &[AGENT], Some("checkpoint (turn_end)"));
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let (state, path) = (gw.state.clone(), guest.path.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            // Not paused any more, but no guest info yet: a plain `busy` ("not configured").
            state.upsert_sandbox(
                SandboxId(SBX.into()),
                Epoch(4),
                std::path::PathBuf::from(&path),
                [AGENT.to_string()],
                None,
            );
            tokio::time::sleep(Duration::from_millis(2000)).await;
            TestGateway::configure(&state, SBX, 4, &path, &[AGENT]);
        });
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &CancellationToken::new(), &split()).await;
        assert!(!r.is_error, "{r:?}");
        assert!(started.elapsed() >= Duration::from_millis(2500), "{:?}", started.elapsed());
    }

    /// A pause past the paused budget ends the call with a message that says the sandbox was
    /// checkpointing, not "bind timed out", and only after the long budget; nothing reached the guest.
    #[tokio::test]
    async fn a_pause_past_the_paused_budget_gives_up_saying_the_sandbox_was_checkpointing() {
        let (gw, guest) = gateway_with_guest().await;
        guest.freeze(true).await;
        gw.set_paused(SBX, 4, &guest.path, &[AGENT], Some("checkpoint (turn_end)"));
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &CancellationToken::new(), &split()).await;
        assert!(r.is_error);
        let text = text_of(&r);
        assert!(text.contains("stayed paused") && text.contains("paused: checkpoint (turn_end)"), "{r:?}");
        let took = started.elapsed();
        assert!(took >= split().paused - Duration::from_millis(200) && took < split().paused + Duration::from_secs(2), "took {took:?}");
        assert!(guest.requests().await.is_empty());
    }

    /// Every other `busy` gets the short budget: a guest not configured yet, a bind that times out
    /// (a frozen guest behind a gateway that can't tell), and a gateway of the previous release
    /// whose `busy` has no `reason` even if its message talks of a pause. Each gives up after the
    /// busy budget, well before the paused one.
    #[tokio::test]
    async fn other_busy_gives_up_after_the_short_budget() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let short = |took: Duration| took >= split().busy - Duration::from_millis(200) && took < split().paused - Duration::from_millis(500);

        // Not configured yet.
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox_booting(SBX, 4, &guest.path, &[AGENT]);
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &CancellationToken::new(), &split()).await;
        assert!(text_of(&r).contains("stayed busy for 1s"), "{r:?}");
        assert!(short(started.elapsed()), "took {:?}", started.elapsed());

        // A bind timeout: the guest frozen, no pause mark, the client's timer shortened below the
        // gateway's so it fires first.
        let (gw, guest) = gateway_with_guest().await;
        guest.freeze(true).await;
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let budgets = Budgets { open: OpenOptions { connect_timeout: Duration::from_millis(300), bind_timeout: Duration::from_millis(300) }, ..split() };
        let started = Instant::now();
        let r = call_with(&agent, "c2".into(), bash("echo hi"), &CancellationToken::new(), &budgets).await;
        assert!(text_of(&r).contains("stayed busy") && text_of(&r).contains("paused or slow"), "{r:?}");
        assert!(short(started.elapsed()), "took {:?}", started.elapsed());

        // A previous-release gateway: `busy` with no reason, whatever its message says.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut old = gw.target(SBX, 4, AGENT);
        old.url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                    let _bind = ws.next().await;
                    let busy = serde_json::json!({"type": "error", "error": {"code": "busy", "message": "the sandbox is paused: checkpoint (turn_end)", "retryable": true}, "executed": false, "retry_after_ms": 100});
                    let _ = ws.send(Message::text(busy.to_string())).await;
                    let _ = ws.close(None).await;
                });
            }
        });
        let (agent, _) = agent_with_resolver(vec![target(old)]);
        let started = Instant::now();
        let r = call_with(&agent, "c3".into(), bash("echo hi"), &CancellationToken::new(), &split()).await;
        assert!(text_of(&r).contains("stayed busy for 1s"), "{r:?}");
        assert!(short(started.elapsed()), "took {:?}", started.elapsed());
    }

    /// A gateway that can't tell the VM is paused (nestd of the previous release): the guest's
    /// vsock stays silent, the gateway answers `busy` after its own timer (the client's is longer),
    /// and the call retries and runs once the guest thaws. Real timers: about 5 s.
    #[tokio::test]
    async fn a_silent_guest_is_the_gateways_busy_and_the_call_retries() {
        let (gw, guest) = gateway_with_guest().await;
        guest.freeze(true).await;
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let g2 = guest.log_handle();
        tokio::spawn(async move {
            // Past the gateway's guest-connect timer, so the first bind is refused.
            tokio::time::sleep(Duration::from_millis(nest_protocol::gateway::GUEST_CONNECT_TIMEOUT_MS + 500)).await;
            g2.lock().await.frozen = false;
        });
        let budgets = Budgets { busy: Duration::from_secs(30), open: OpenOptions::default(), ..quick() };
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &CancellationToken::new(), &budgets).await;
        assert!(!r.is_error, "{r:?}");
        assert!(started.elapsed() >= Duration::from_millis(nest_protocol::gateway::GUEST_CONNECT_TIMEOUT_MS), "{:?}", started.elapsed());
        assert_eq!(guest.requests().await.len(), 1);
        assert_eq!(*resolves.lock().unwrap(), 1);
    }

    /// An interrupt during a bind that would take the whole bind timeout ends the call at once.
    #[tokio::test]
    async fn an_interrupt_during_a_slow_bind_ends_the_call_at_once() {
        let (gw, guest) = gateway_with_guest().await;
        guest.freeze(true).await;
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let tx = CancellationToken::new();
        let rx = tx.clone();
        let a2 = agent.clone();
        let budgets = Budgets { open: OpenOptions::default(), ..quick() };
        let h = tokio::spawn(async move { call_with(&a2, "c1".into(), bash("echo hi"), &rx, &budgets).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let at = Instant::now();
        tx.cancel();
        let r = h.await.unwrap();
        assert!(text_of(&r).contains("interrupted"), "{r:?}");
        assert!(at.elapsed() < Duration::from_secs(2), "took {:?} (the gateway's timer is 5 s)", at.elapsed());
    }

    #[tokio::test]
    async fn not_ready_waits_and_not_bound_fails() {
        let (gw, _guest) = gateway_with_guest().await;
        let not_ready = HandsOutcome::Error {
            error: ErrorBody { code: SANDBOX_NOT_READY.into(), message: "placing".into(), retryable: true },
            retry_after_ms: Some(50),
        };
        let (agent, resolves) = agent_with_resolver(vec![Some(not_ready), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);

        let not_bound = HandsOutcome::Error {
            error: ErrorBody { code: error_codes::NOT_BOUND.into(), message: "agent has no hands".into(), retryable: false },
            retry_after_ms: None,
        };
        let (agent, _) = agent_with_resolver(vec![Some(not_bound)]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c2".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("not_bound"), "{r:?}");
    }

    #[tokio::test]
    async fn the_not_ready_budget_ends_a_call_even_with_a_huge_hint() {
        let (gw, _guest) = gateway_with_guest().await;
        let forever = HandsOutcome::Error {
            error: ErrorBody { code: SANDBOX_NOT_READY.into(), message: "placing".into(), retryable: true },
            retry_after_ms: Some(600_000),
        };
        let (agent, _) = agent_with_resolver(vec![Some(forever)]);
        let rx = CancellationToken::new();
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("not ready"), "{r:?}");
        assert!(started.elapsed() < quick().not_ready + Duration::from_secs(2), "took {:?}", started.elapsed());
        drop(gw);
    }

    #[tokio::test]
    async fn an_unanswered_resolve_is_an_error_result() {
        let (agent, resolves) = agent_with_resolver(vec![None]);
        let rx = CancellationToken::new();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("did not answer"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 1);
        assert!(agent.pending_resolves.lock().unwrap().is_empty(), "the timed-out request is forgotten");
    }

    #[tokio::test]
    async fn a_dropped_call_leaves_no_pending_resolve() {
        let (agent, _) = agent_with_resolver(vec![None]);
        let rx = CancellationToken::new();
        let a2 = agent.clone();
        let h = tokio::spawn(async move { call(&a2, "c1".into(), bash("echo hi"), rx).await });
        let deadline = Instant::now() + SOON;
        while agent.pending_resolves.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "the call never sent hands_resolve");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        h.abort();
        let _ = h.await;
        assert!(agent.pending_resolves.lock().unwrap().is_empty(), "the dropped call's request is forgotten");
    }

    #[tokio::test]
    async fn parallel_first_calls_share_one_resolve() {
        let (gw, guest) = gateway_with_guest().await;
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let mut handles = Vec::new();
        let mut cancels = Vec::new();
        for i in 0..4 {
            let a2 = agent.clone();
            let rx = CancellationToken::new();
            cancels.push(rx.clone());
            handles.push(tokio::spawn(async move { call(&a2, format!("c{i}"), bash("echo hi"), rx).await }));
        }
        for h in handles {
            let r = h.await.unwrap();
            assert!(!r.is_error, "{r:?}");
        }
        assert_eq!(*resolves.lock().unwrap(), 1, "N parallel first calls send one hands_resolve");
        assert_eq!(guest.requests().await.len(), 4);
    }

    #[tokio::test]
    async fn a_refusal_does_not_drop_a_fresher_target_another_call_stored() {
        let (gw, _guest) = gateway_with_guest().await;
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let stale_gen = agent.set_hands_target(gw.target(SBX, 3, AGENT));
        let fresh_gen = agent.set_hands_target(gw.target(SBX, 4, AGENT));
        agent.drop_target_if(stale_gen);
        assert_eq!(agent.hands_target().map(|(_, g)| g), Some(fresh_gen), "an old generation never drops a newer target");
        agent.drop_target_if(fresh_gen);
        assert!(agent.hands_target().is_none());
    }

    #[tokio::test]
    async fn the_sandbox_leaving_mid_call_is_an_unknown_outcome_and_drops_the_target() {
        let (gw, guest) = gateway_with_guest().await;
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let a2 = agent.clone();
        let h = tokio::spawn(async move { call(&a2, "c1".into(), bash("sleep 30"), rx).await });
        guest_saw(&guest, 1).await;
        gw.state.remove_sandbox(&SandboxId(SBX.into()));
        let r = h.await.unwrap();
        assert!(r.is_error);
        assert!(text_of(&r).contains(OUTCOME_UNKNOWN), "{r:?}");
        assert!(agent.hands_target().is_none(), "the target is dropped so the next call resolves again");
    }

    #[tokio::test]
    async fn a_connection_lost_after_the_request_is_an_unknown_outcome() {
        let (gw, guest) = gateway_with_guest().await;
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        // The fake guest hangs up right after reading this request; the gateway then closes
        // the WebSocket, with no result ever sent.
        let r = call(&agent, "c1".into(), bash("hangup"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains(OUTCOME_UNKNOWN), "{r:?}");
        assert_eq!(guest.requests().await.len(), 1, "the request did reach the guest");
        assert!(agent.hands_target().is_some(), "a dropped connection is not a refused target");
    }

    /// R6 (gateway-bindings B2): a request whose send fails part-way may have reached the guest,
    /// so the call is `outcome_unknown`, not a plain error the model would retry. A "gateway"
    /// binds, then resets the connection while the client is still writing a large request.
    #[tokio::test]
    async fn a_request_send_that_fails_part_way_is_an_unknown_outcome() {
        use futures_util::{SinkExt, StreamExt};
        use nest_protocol::gateway::{GatewayMessage, GuestInfo};
        use tokio_tungstenite::tungstenite::Message;
        let gw = TestGateway::start().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut t = gw.target(SBX, 4, AGENT);
        t.url = format!("ws://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tcp.set_zero_linger().unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let _bind = ws.next().await;
            let bound = GatewayMessage::Bound { guest: GuestInfo { protocol_version: 1, capabilities: vec![] }, gateway_version: 1 };
            ws.send(Message::text(serde_json::to_string(&bound).unwrap())).await.unwrap();
            // Read nothing: the client's write backs up, then the reset fails it.
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(ws);
        });
        let (agent, _) = agent_with_resolver(vec![target(t)]);
        let big = op_from_mcp("Write", &json!({"file_path": "/x", "content": "x".repeat(15 << 20)})).unwrap();
        let rx = CancellationToken::new();
        let r = call_with(&agent, "c1".into(), big, &rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains(OUTCOME_UNKNOWN), "{r:?}");
    }

    #[tokio::test]
    async fn a_first_frame_for_another_client_is_refused_and_drops_the_target() {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox(SBX, 4, &guest.path, &[AGENT, "agt_other"]);
        // A binding for another attached client: the bind succeeds, the first frame's agent id
        // does not match it, and the gateway closes with 4401 before forwarding anything.
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, "agt_other"))]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("hands refused"), "{r:?}");
        assert!(guest.requests().await.is_empty(), "nothing reached the guest");
        assert!(agent.hands_target().is_none());
    }

    #[tokio::test]
    async fn an_edge_5xx_pauses_then_resolves_again_once_and_a_403_resolves_again_at_once() {
        // The first target's hostname has no connector behind it (a dead host's tunnel, or one
        // reconnecting): Cloudflare answers 530. The fresh target is the live gateway.
        let (gw, guest) = gateway_with_guest().await;
        let mut gone = gw.target(SBX, 4, AGENT);
        gone.url = http_status_server(530).await;
        let (agent, resolves) = agent_with_resolver(vec![target(gone), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let mut budgets = quick();
        budgets.edge_pause = Duration::from_millis(80);
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), &rx, &budgets).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "a 5xx from the edge resolves again once");
        assert!(started.elapsed() >= Duration::from_millis(80), "the re-resolve waits the edge pause first");
        assert_eq!(guest.requests().await.len(), 1);

        // Access refusing the credential: resolve again (a rotated token rides on the fresh
        // target) without the pause.
        let mut refused = gw.target(SBX, 4, AGENT);
        refused.url = http_status_server(403).await;
        let (agent, resolves) = agent_with_resolver(vec![target(refused), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let mut budgets = quick();
        budgets.edge_pause = Duration::from_secs(5);
        let started = Instant::now();
        let r = call_with(&agent, "c2".into(), bash("echo hi"), &rx, &budgets).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "an Access refusal resolves again once");
        assert!(started.elapsed() < Duration::from_secs(5), "no pause for a refused credential");

        // The gateway's own 404 (an unknown route) is final: one resolve, an error result.
        let mut wrong = gw.target(SBX, 4, AGENT);
        wrong.url = http_status_server(404).await;
        let (agent, resolves) = agent_with_resolver(vec![target(wrong), target(gw.target(SBX, 4, AGENT))]);
        let rx = CancellationToken::new();
        let r = call_with(&agent, "c3".into(), bash("echo hi"), &rx, &quick()).await;
        assert!(r.is_error, "{r:?}");
        assert!(text_of(&r).contains("http 404"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 1, "a 404 is the gateway's answer, not a stale target");
    }

    #[tokio::test]
    async fn an_unreachable_gateway_is_an_error_result_after_one_re_resolve() {
        let gw = TestGateway::start().await;
        let mut t = gw.target(SBX, 4, AGENT);
        // A port nothing listens on.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        t.url = format!("ws://{}", l.local_addr().unwrap());
        drop(l);
        let (agent, resolves) = agent_with_resolver(vec![target(t)]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("hands unavailable"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "a refused connect resolves again once");
    }

    #[tokio::test]
    async fn requests_carry_the_bindings_epoch_not_the_targets_unsigned_copies() {
        let (gw, guest) = gateway_with_guest().await;
        // The previous release's unsigned copies, here disagreeing with the signed claims (epoch 4).
        let mut t = gw.target(SBX, 4, AGENT);
        t.sandbox = Some(SandboxId("sbx_somewhere_else".into()));
        t.epoch = Some(Epoch(99));
        let (agent, _) = agent_with_resolver(vec![target(t)]);
        let rx = CancellationToken::new();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(guest.requests().await[0].epoch, Epoch(4), "the request carries the claims' epoch");
    }

    #[tokio::test]
    async fn an_answer_nobody_awaits_is_ignored() {
        let (agent, _) = agent_with_resolver(vec![]);
        let e = ErrorBody { code: SANDBOX_NOT_READY.into(), message: "m".into(), retryable: true };
        let o = HandsOutcome::Error { error: e, retry_after_ms: None };
        agent.resolve_hands(&nest_protocol::model::RequestId("req_unknown".into()), o);
        assert!(agent.pending_resolves.lock().unwrap().is_empty());
    }
}
