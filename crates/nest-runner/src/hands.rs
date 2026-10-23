//! Hands for the runner: one gateway WebSocket per tool call, through `nest-hands-client`.
//!
//! The runner never sees a vsock socket. It holds the sandbox's ids from `agent_start` and asks
//! AgentDO for the target (gateway URL, binding, guest version) over its own session channel
//! (`hands_resolve`), lazily before the first call and again whenever a gateway refuses the
//! target. The MCP arguments are forwarded verbatim (tagged with the tool name), and the
//! guest's `HandsResult` content maps 1:1 to MCP content. Cancelling sends `cancel` and, if the
//! guest doesn't answer promptly, hangs up (which also cancels).

use std::sync::Arc;
use std::time::{Duration, Instant};

use nest_hands_client::{OpenError, OpenOptions, Phase, RecvError, RefusalCode};
use nest_protocol::gateway::HandsTarget;
use nest_protocol::guest::{HandsCancel, HandsOp, HandsRequest, HandsResponse, HandsResult, ToolContent};
use nest_protocol::host::mcp::{McpContent, ToolCallResult};
use nest_protocol::model::ErrorBody;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::runtime::{Agent, HandsResolveOutcome, OUTCOME_UNKNOWN, ResolveTimeout};

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
    /// Total wait while the gateway answers `busy` (guest not configured, a resync, vsock down).
    pub busy: Duration,
    /// The longest single sleep, whatever a `retry_after_ms` hint says.
    pub max_sleep: Duration,
    pub open: OpenOptions,
}

impl Default for Budgets {
    fn default() -> Self {
        Budgets {
            resolve_timeout: Duration::from_secs(10),
            not_ready: Duration::from_secs(60),
            busy: Duration::from_secs(30),
            max_sleep: Duration::from_secs(10),
            open: OpenOptions::default(),
        }
    }
}

const NOT_READY_RETRY: Duration = Duration::from_secs(2);
const BUSY_RETRY: Duration = Duration::from_millis(500);

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
pub async fn call(agent: &Arc<Agent>, call_id: String, op: HandsOp, cancel: oneshot::Receiver<()>) -> ToolCallResult {
    call_with(agent, call_id, op, cancel, &Budgets::default()).await
}

/// Fetch the target in the background right after `agent_start`, so the SessionStart hook and
/// the first tool call find it cached. Waits through `sandbox_not_ready` like a call would.
pub fn prefetch_target(agent: Arc<Agent>) {
    if agent.inner.lock().unwrap().hands.is_none() {
        return;
    }
    tokio::spawn(async move {
        let (_never_tx, mut never) = oneshot::channel::<()>();
        if let Err(r) = ensure_target(&agent, &mut never, &Budgets::default()).await {
            tracing::info!(agent = %agent.id, "hands target not prefetched: {}", r.content.first().map(|c| format!("{c:?}")).unwrap_or_default());
        }
    });
}

/// [`call`] with explicit budgets.
pub async fn call_with(
    agent: &Arc<Agent>,
    call_id: String,
    op: HandsOp,
    mut cancel: oneshot::Receiver<()>,
    budgets: &Budgets,
) -> ToolCallResult {
    let mut re_resolved = false;
    let mut busy_since: Option<Instant> = None;
    let (mut conn, epoch, generation) = loop {
        let (target, generation) = match ensure_target(agent, &mut cancel, budgets).await {
            Ok(t) => t,
            Err(r) => return r,
        };
        match nest_hands_client::open(&target, &budgets.open).await {
            Ok(c) => break (c, target.epoch, generation),
            Err(OpenError::Refused(r)) if r.code == RefusalCode::Busy => {
                let since = *busy_since.get_or_insert_with(Instant::now);
                let wait = r.retry_after_ms.map(Duration::from_millis).unwrap_or(BUSY_RETRY);
                let Some(wait) = capped(wait, since, budgets.busy, budgets.max_sleep) else {
                    return ToolCallResult::error(format!(
                        "hands unavailable: the gateway stayed busy for {}s ({})",
                        budgets.busy.as_secs(),
                        r.message
                    ));
                };
                if sleep_or_cancel(wait, &mut cancel).await {
                    return ToolCallResult::error("interrupted");
                }
            }
            Err(e) => {
                // Whatever refused this target, it is not worth keeping: the next call fetches
                // a fresh one. Refusals a fresh target may cure get one retry in this call.
                agent.drop_target_if(generation);
                if !re_resolved && needs_resolve(&e) {
                    tracing::info!(agent = %agent.id, sandbox = %target.sandbox, "hands target refused ({e}); resolving again");
                    re_resolved = true;
                    continue;
                }
                return ToolCallResult::error(format!("hands unavailable: {e}"));
            }
        }
    };
    let req = HandsRequest {
        protocol_version: conn.guest().protocol_version,
        call_id,
        agent_id: agent.id.clone(),
        epoch,
        op,
    };
    if let Err(e) = conn.send_json(&req).await {
        return ToolCallResult::error(format!("hands request failed: {e}"));
    }
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
                _ = &mut cancel => {
                    cancelled = true;
                    continue;
                }
            }
        };
        match next {
            Ok(Some(HandsResponse::Started { .. })) => continue,
            Ok(Some(HandsResponse::Result { result, .. })) => break to_mcp(result),
            Ok(Some(HandsResponse::Error { error, .. })) => break error_result(&error),
            Ok(None) if cancelled => break ToolCallResult::error("interrupted"),
            Ok(None) => break ToolCallResult::error("hands connection closed before a result"),
            Err(RecvError::Closed(c)) if c.is_moved() => {
                agent.drop_target_if(generation);
                break ToolCallResult::error(format!(
                    "{OUTCOME_UNKNOWN}: the sandbox left its host while the call ran; the call may or may not have \
                     taken effect. Check before retrying anything with side effects. ({c})"
                ));
            }
            Err(RecvError::Closed(c)) if c.is_unauthorized() => {
                agent.drop_target_if(generation);
                break ToolCallResult::error(format!("hands refused: {c}"));
            }
            Err(e) if cancelled => break ToolCallResult::error(format!("interrupted ({e})")),
            Err(e) => break ToolCallResult::error(format!("hands connection lost: {e}")),
        }
    };
    tokio::spawn(conn.close());
    outcome
}

/// A refusal that a fresh target may cure: the binding is stale, expired or for a rotated key,
/// the sandbox moved, or nothing answers where the target points (refused, reset, or a host
/// that never completes the upgrade).
fn needs_resolve(e: &OpenError) -> bool {
    match e {
        OpenError::Refused(r) => r.resolve_again() || r.code == RefusalCode::Unauthorized,
        OpenError::Transport(t) => t.is_unreachable(),
        OpenError::Timeout(Phase::Connect) => true,
        OpenError::Timeout(Phase::Bind) | OpenError::Protocol(_) => false,
    }
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
    cancel: &mut oneshot::Receiver<()>,
    budgets: &Budgets,
) -> Result<(HandsTarget, u64), ToolCallResult> {
    if let Some(t) = agent.hands_target() {
        return Ok(t);
    }
    let _gate = tokio::select! {
        g = agent.resolve_gate.lock() => g,
        _ = &mut *cancel => return Err(ToolCallResult::error("interrupted")),
    };
    if let Some(t) = agent.hands_target() {
        return Ok(t);
    }
    let started = Instant::now();
    loop {
        let outcome = tokio::select! {
            r = agent.resolve_hands_target(budgets.resolve_timeout) => r,
            _ = &mut *cancel => return Err(ToolCallResult::error("interrupted")),
        };
        match outcome {
            Ok(HandsResolveOutcome::Target(t)) => {
                let generation = agent.set_hands_target(t.clone());
                return Ok((t, generation));
            }
            Ok(HandsResolveOutcome::Error { error, retry_after_ms }) if error.code == SANDBOX_NOT_READY && error.retryable => {
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
            Ok(HandsResolveOutcome::Error { error, .. }) => return Err(error_result(&error)),
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
async fn sleep_or_cancel(d: Duration, cancel: &mut oneshot::Receiver<()>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(d) => false,
        _ = &mut *cancel => true,
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
    use nest_protocol::model::{AgentId, AgentRole, Epoch, SandboxId, error_codes};
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
    fn agent_with_resolver(answers: Vec<Option<HandsResolveOutcome>>) -> (Arc<Agent>, Arc<Mutex<usize>>) {
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel::<AgentCmd>();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Outbound>();
        let agent = Agent::new(
            AgentId(AGENT.into()),
            AgentRole::Worker,
            Epoch(4),
            std::env::temp_dir(),
            Some(HandsBinding { sandbox: SandboxId(SBX.into()), epoch: Epoch(4) }),
            None,
            vec![],
            0,
            cmd_tx,
            out_tx,
        );
        let resolves = Arc::new(Mutex::new(0usize));
        let (a2, r2) = (agent.clone(), resolves.clone());
        let mut answers: VecDeque<Option<HandsResolveOutcome>> = answers.into();
        tokio::spawn(async move {
            while let Some(o) = out_rx.recv().await {
                if let Outbound::HandsResolve(req) = o {
                    *r2.lock().unwrap() += 1;
                    let answer = if answers.len() > 1 {
                        answers.pop_front().unwrap()
                    } else {
                        answers.front().and_then(|a| a.as_ref().map(clone_outcome))
                    };
                    if let Some(answer) = answer {
                        a2.resolve_hands(&req, answer);
                    }
                }
            }
        });
        (agent, resolves)
    }

    fn clone_outcome(o: &HandsResolveOutcome) -> HandsResolveOutcome {
        match o {
            HandsResolveOutcome::Target(t) => HandsResolveOutcome::Target(t.clone()),
            HandsResolveOutcome::Error { error, retry_after_ms } => {
                HandsResolveOutcome::Error { error: error.clone(), retry_after_ms: *retry_after_ms }
            }
        }
    }

    fn target(t: HandsTarget) -> Option<HandsResolveOutcome> {
        Some(HandsResolveOutcome::Target(t))
    }

    fn bash(cmd: &str) -> HandsOp {
        op_from_mcp("Bash", &json!({"command": cmd})).unwrap()
    }

    fn quick() -> Budgets {
        Budgets {
            resolve_timeout: Duration::from_millis(300),
            not_ready: Duration::from_millis(600),
            busy: Duration::from_millis(600),
            max_sleep: Duration::from_millis(100),
            open: OpenOptions { connect_timeout: Duration::from_millis(300), bind_timeout: Duration::from_secs(5) },
        }
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
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(r.content, vec![McpContent::Text { text: "ran: echo hi".into() }]);
        let seen = guest.requests().await;
        assert_eq!((seen[0].call_id.as_str(), seen[0].epoch, seen[0].agent_id.0.as_str()), ("c1", Epoch(4), AGENT));

        // A second call reuses the cached target: no new resolve.
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c2".into(), bash("echo again"), rx).await;
        assert!(!r.is_error);
        assert_eq!(*resolves.lock().unwrap(), 1, "the target is cached across calls");

        // `sleep` blocks in the fake until cancelled.
        let (tx, rx) = oneshot::channel();
        let a2 = agent.clone();
        let h = tokio::spawn(async move { call(&a2, "c3".into(), bash("sleep 30"), rx).await });
        guest_saw(&guest, 3).await;
        let cancelled_at = Instant::now();
        tx.send(()).unwrap();
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
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);
        assert_eq!(guest.requests().await[0].epoch, Epoch(4));

        // Two stale answers in a row: one re-resolve, then an error result, never a loop; and
        // the refused target is not kept for the next call.
        let (agent, resolves) = agent_with_resolver(vec![target(gw.target(SBX, 3, AGENT))]);
        let (_tx, rx) = oneshot::channel();
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
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "unauthorized (expired) resolves again once");
        assert_eq!(guest.requests().await.len(), 1);
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
        let (_tx, rx) = oneshot::channel();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), rx, &quick()).await;
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
        let (_tx, rx) = oneshot::channel();
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
        let (_tx, rx) = oneshot::channel();
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("stayed busy"), "{r:?}");
        assert!(started.elapsed() < quick().busy + Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn not_ready_waits_and_not_bound_fails() {
        let (gw, _guest) = gateway_with_guest().await;
        let not_ready = HandsResolveOutcome::Error {
            error: ErrorBody { code: SANDBOX_NOT_READY.into(), message: "placing".into(), retryable: true },
            retry_after_ms: Some(50),
        };
        let (agent, resolves) = agent_with_resolver(vec![Some(not_ready), target(gw.target(SBX, 4, AGENT))]);
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(!r.is_error, "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2);

        let not_bound = HandsResolveOutcome::Error {
            error: ErrorBody { code: error_codes::NOT_BOUND.into(), message: "agent has no hands".into(), retryable: false },
            retry_after_ms: None,
        };
        let (agent, _) = agent_with_resolver(vec![Some(not_bound)]);
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c2".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("not_bound"), "{r:?}");
    }

    #[tokio::test]
    async fn the_not_ready_budget_ends_a_call_even_with_a_huge_hint() {
        let (gw, _guest) = gateway_with_guest().await;
        let forever = HandsResolveOutcome::Error {
            error: ErrorBody { code: SANDBOX_NOT_READY.into(), message: "placing".into(), retryable: true },
            retry_after_ms: Some(600_000),
        };
        let (agent, _) = agent_with_resolver(vec![Some(forever)]);
        let (_tx, rx) = oneshot::channel();
        let started = Instant::now();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("not ready"), "{r:?}");
        assert!(started.elapsed() < quick().not_ready + Duration::from_secs(2), "took {:?}", started.elapsed());
        drop(gw);
    }

    #[tokio::test]
    async fn an_unanswered_resolve_is_an_error_result() {
        let (agent, resolves) = agent_with_resolver(vec![None]);
        let (_tx, rx) = oneshot::channel();
        let r = call_with(&agent, "c1".into(), bash("echo hi"), rx, &quick()).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("did not answer"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 1);
        assert!(agent.pending_resolves.lock().unwrap().is_empty(), "the timed-out request is forgotten");
    }

    #[tokio::test]
    async fn a_dropped_call_leaves_no_pending_resolve() {
        let (agent, _) = agent_with_resolver(vec![None]);
        let (_tx, rx) = oneshot::channel();
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
            let (tx, rx) = oneshot::channel();
            cancels.push(tx);
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
        let (_tx, rx) = oneshot::channel();
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
    async fn a_first_frame_for_another_client_is_refused_and_drops_the_target() {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox(SBX, 4, &guest.path, &[AGENT, "agt_other"]);
        // A binding for another attached client: the bind succeeds, the first frame's agent id
        // does not match it, and the gateway closes with 4401 before forwarding anything.
        let (agent, _) = agent_with_resolver(vec![target(gw.target(SBX, 4, "agt_other"))]);
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("hands refused"), "{r:?}");
        assert!(guest.requests().await.is_empty(), "nothing reached the guest");
        assert!(agent.hands_target().is_none());
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
        let (_tx, rx) = oneshot::channel();
        let r = call(&agent, "c1".into(), bash("echo hi"), rx).await;
        assert!(r.is_error);
        assert!(text_of(&r).contains("hands unavailable"), "{r:?}");
        assert_eq!(*resolves.lock().unwrap(), 2, "a refused connect resolves again once");
    }

    #[tokio::test]
    async fn hands_resolved_wire_shapes_map_to_outcomes() {
        let (agent, _) = agent_with_resolver(vec![]);
        match HandsResolveOutcome::from_wire(None, None, None) {
            HandsResolveOutcome::Error { error, .. } => assert_eq!(error.code, error_codes::INVALID_MESSAGE),
            o => panic!("{o:?}"),
        }
        let e = ErrorBody { code: SANDBOX_NOT_READY.into(), message: "m".into(), retryable: true };
        match HandsResolveOutcome::from_wire(None, Some(e.clone()), Some(7)) {
            HandsResolveOutcome::Error { error, retry_after_ms } => assert_eq!((error, retry_after_ms), (e, Some(7))),
            o => panic!("{o:?}"),
        }
        // An answer nobody awaits is ignored, not a panic, and leaves nothing behind.
        agent.resolve_hands(&nest_protocol::model::RequestId("req_unknown".into()), HandsResolveOutcome::from_wire(None, None, None));
        assert!(agent.pending_resolves.lock().unwrap().is_empty());
    }
}
