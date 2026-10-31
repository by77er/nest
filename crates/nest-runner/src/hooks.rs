//! Hook intake: async tracking datagrams (→ state events) and synchronous decisions answered
//! from local state only (the `AgentCache`, the inbox mirror, the hands connection).

use std::io::BufRead;
use std::sync::Arc;
use std::time::Duration;

use nest_protocol::control::RuleDecision;
use nest_protocol::host::hook::{
    HookDatagram, HookDecisionRequest, HookDecisionResponse, HookOutput, HookSpecificOutput, PermissionDecision,
    PermissionRequestDecision, TopLevelDecision,
};
use nest_protocol::host::mcp::McpContent;
use nest_protocol::model::{AgentEventBody, AgentState, MessageId};
use serde_json::{Value, json};
use tokio::net::{UnixDatagram, UnixListener};

use crate::framing;
use crate::hands;
use crate::rules;
use crate::mirror;
use crate::runtime::{Agent, AgentCmd, Runtime};

/// Serve async tracking datagrams forever.
pub async fn serve_dgram(rt: Arc<Runtime>, sock: UnixDatagram) {
    let mut buf = vec![0u8; nest_protocol::host::hook::MAX_DATAGRAM + 4096];
    loop {
        let n = match sock.recv(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                tracing::warn!("hook dgram recv: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        match serde_json::from_slice::<HookDatagram>(&buf[..n]) {
            Ok(d) => {
                if let Some(a) = rt.agent(&d.agent) {
                    track(&a, &d.input);
                }
            }
            Err(e) => tracing::debug!("bad hook datagram: {e}"),
        }
    }
}

/// Serve sync decision hooks forever (one request frame, one response frame per connection).
/// The declared agent must match the brain the peer process descends from.
pub async fn serve_sync(rt: Arc<Runtime>, listener: UnixListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let rt = rt.clone();
        tokio::spawn(async move {
            let req: HookDecisionRequest = match framing::read_host(&mut stream).await {
                Ok(Some(r)) => r,
                _ => return,
            };
            let peer = stream.peer_cred().ok().and_then(|c| c.pid());
            let Some(agent) = peer_agent(&rt, peer, &req.agent).await else {
                tracing::warn!(agent = %req.agent, ?peer, "hook from a process that isn't that agent's brain; using the fallback");
                let _ = framing::write_host(&mut stream, &HookDecisionResponse { output: fallback(&req.input) }).await;
                return;
            };
            let answer = decide(&rt, &req).await;
            let written = framing::write_host(&mut stream, &HookDecisionResponse { output: answer.output.clone() }).await.is_ok();
            answer.settle(&agent, written);
        });
    }
}

/// The agent whose Claude Code process `peer` (a pid from `SO_PEERCRED`) descends from, if it is
/// the one `declared`. Retries briefly: right after a spawn the pid may not be recorded yet.
pub async fn peer_agent(rt: &Runtime, peer: Option<i32>, declared: &nest_protocol::model::AgentId) -> Option<Arc<Agent>> {
    let pid = peer?;
    for _ in 0..10 {
        if let Some(a) = rt.agent_for_pid(pid) {
            return (&a.id == declared).then_some(a);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    None
}

/// Drain `nest-hook-spool.jsonl` (datagrams `nest hook` couldn't send).
pub fn drain_spool(agent: &Agent) {
    let path = agent.config_dir.join("nest-hook-spool.jsonl");
    let draining = path.with_extension("jsonl.draining");
    if std::fs::rename(&path, &draining).is_err() {
        return;
    }
    if let Ok(f) = std::fs::File::open(&draining) {
        for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
            if let Ok(d) = serde_json::from_str::<HookDatagram>(&line) {
                track(agent, &d.input);
            }
        }
    }
    let _ = std::fs::remove_file(&draining);
}

/// Hook input → state event (tracking only, never blocks anything).
pub fn track(agent: &Agent, input: &Value) {
    let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    let (state, detail) = match event {
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "PreToolUse" | "PostCompact" => (AgentState::Working, None),
        "PermissionRequest" => (AgentState::WaitingPermission, None),
        "Notification" => (AgentState::NeedsAttention, input.get("message").and_then(Value::as_str).map(String::from)),
        "PreCompact" => (AgentState::Compacting, None),
        "StopFailure" => {
            let err = input.get("error").map(|e| e.to_string()).unwrap_or_default();
            if err.contains("rate_limit") { (AgentState::QuotaParked, Some(err)) } else { (AgentState::Errored, Some(err)) }
        }
        "SessionEnd" => (AgentState::Detached, input.get("reason").and_then(Value::as_str).map(String::from)),
        "SessionStart" => (AgentState::Ready, input.get("source").and_then(Value::as_str).map(String::from)),
        "Stop" => (AgentState::Idle, None),
        "SubagentStart" | "SubagentStop" => {
            let kind = input.get("agent_type").and_then(Value::as_str).unwrap_or("subagent");
            (AgentState::Working, Some(format!("{}: {kind}", if event == "SubagentStart" { "subagent started" } else { "subagent stopped" })))
        }
        "Elicitation" => (AgentState::WaitingInput, input.get("message").and_then(Value::as_str).map(String::from)),
        _ => return,
    };
    agent.emit(AgentEventBody::StateChanged { state, detail });
}

fn fallback(input: &Value) -> HookOutput {
    let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    nest_protocol::host::hook::fallback_output(event).unwrap_or_default()
}

/// A sync hook's answer, and the inbox messages it hands the model: confirmed to AgentDO
/// (`inbox_delivered`) once the answer is written, pending again if it isn't.
#[derive(Default)]
pub struct Answer {
    pub output: HookOutput,
    handed: Vec<MessageId>,
    /// A `Stop` answer that blocks: the actor was told a continuation is owed.
    stop_blocked: bool,
}

impl From<HookOutput> for Answer {
    fn from(output: HookOutput) -> Self {
        Answer { output, ..Default::default() }
    }
}

impl Answer {
    pub fn settle(self, agent: &Agent, written: bool) {
        if written {
            for id in self.handed {
                agent.emit(AgentEventBody::InboxDelivered { message: id });
            }
            return;
        }
        agent.inner.lock().unwrap().mirror.release(&self.handed);
        if self.stop_blocked {
            // Claude Code got no `block`, so the turn ends after all.
            agent.command(AgentCmd::StopHook { blocked: false });
            agent.emit(AgentEventBody::StateChanged { state: AgentState::Idle, detail: None });
        }
    }
}

/// Answer a sync hook. Never waits on the network (the `SessionStart` read goes through hands).
pub async fn decide(rt: &Runtime, req: &HookDecisionRequest) -> Answer {
    let event = req.input.get("hook_event_name").and_then(Value::as_str).unwrap_or_default();
    let Some(agent) = rt.agent(&req.agent) else { return fallback(&req.input).into() };
    // A Stop is idle only if it lets the turn end; `stop` decides.
    if event != "Stop" {
        track(&agent, &req.input);
    }
    let output = match event {
        "PreToolUse" => {
            let (decision, reason) = permission(&agent, &req.input);
            HookOutput {
                hook_specific_output: Some(HookSpecificOutput::PreToolUse {
                    permission_decision: Some(decision),
                    permission_decision_reason: reason,
                    updated_input: None,
                    additional_context: None,
                }),
                ..Default::default()
            }
        }
        "PermissionRequest" => {
            let (decision, reason) = permission(&agent, &req.input);
            let decision = match decision {
                PermissionDecision::Allow => PermissionRequestDecision::Allow { updated_input: None },
                _ => PermissionRequestDecision::Deny { message: reason, interrupt: None },
            };
            HookOutput { hook_specific_output: Some(HookSpecificOutput::PermissionRequest { decision }), ..Default::default() }
        }
        // A subagent's tool call (its input names `agent_id`) gets nothing: the context would reach
        // the subagent, not the main loop (checked on Claude Code 2.1.316), yet count as delivered.
        "PostToolUse" if req.input.get("agent_id").is_none() => return tool_boundary(&agent),
        "Stop" => return stop(&agent, &req.input),
        "SessionStart" => session_start(rt, &agent, &req.input).await,
        _ => HookOutput::default(),
    };
    output.into()
}

/// PreToolUse / PermissionRequest: first matching rule; `ask` escalates and denies for now.
fn permission(agent: &Agent, input: &Value) -> (PermissionDecision, Option<String>) {
    let tool = input.get("tool_name").and_then(Value::as_str).unwrap_or_default();
    let tool_input = input.get("tool_input").cloned().unwrap_or(Value::Null);
    let rules = match agent.inner.lock().unwrap().cache.as_ref() {
        Some(c) => c.rules.clone(),
        None => return (PermissionDecision::Deny, Some("nest policy not loaded yet; retry shortly".into())),
    };
    let v = rules::evaluate(&rules, tool, &tool_input);
    match v.decision {
        RuleDecision::Allow => (PermissionDecision::Allow, v.reason),
        RuleDecision::Deny => (PermissionDecision::Deny, Some(v.reason.unwrap_or_else(|| format!("{tool} is not permitted")))),
        RuleDecision::Ask => {
            let call = agent.escalate(tool, tool_input);
            (PermissionDecision::Deny, Some(format!("pending approval (request {call}); end your turn and wait for the answer")))
        }
    }
}

/// PostToolUse: hand pending inbox-mirror messages to the model with the tool's result.
fn tool_boundary(agent: &Agent) -> Answer {
    let pending = {
        let inner = &mut *agent.inner.lock().unwrap();
        inner.mirror.take(inner.cache.as_ref())
    };
    if pending.is_empty() {
        return Answer::default();
    }
    let additional_context = Some(mirror::render(&pending));
    let output = HookOutput { hook_specific_output: Some(HookSpecificOutput::PostToolUse { additional_context }), ..Default::default() };
    Answer { output, handed: pending.into_iter().map(|m| m.id).collect(), stop_blocked: false }
}

/// Stop: hand pending inbox-mirror messages to the model as `decision: block`. The actor learns
/// whether this stop blocked before Claude Code can act on the answer.
fn stop(agent: &Agent, input: &Value) -> Answer {
    let active = input.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false);
    let pending = {
        let inner = &mut *agent.inner.lock().unwrap();
        inner.mirror.take_at_stop(inner.cache.as_ref(), active)
    };
    agent.command(AgentCmd::StopHook { blocked: !pending.is_empty() });
    if pending.is_empty() {
        track(agent, input);
        return Answer::default();
    }
    let output = HookOutput { decision: Some(TopLevelDecision::Block), reason: Some(mirror::render(&pending)), ..Default::default() };
    Answer { output, handed: pending.into_iter().map(|m| m.id).collect(), stop_blocked: true }
}

/// SessionStart: rebase the tailer on the reported transcript path and pass the repo's
/// CLAUDE.md (read through hands) as additional context.
async fn session_start(rt: &Runtime, agent: &Arc<Agent>, input: &Value) -> HookOutput {
    if let Some(p) = input.get("transcript_path").and_then(Value::as_str) {
        match valid_transcript(agent, p) {
            Some(path) => agent.set_transcript(path),
            None => tracing::warn!(agent = %agent.id, path = p, "ignoring a transcript_path outside the agent's config dir"),
        }
    }
    if agent.hands.is_none() {
        return HookOutput::default();
    }
    let op = match hands::op_from_mcp(
        "Bash",
        &json!({"command": "cat CLAUDE.md 2>/dev/null || true", "timeout": 5000, "description": "nest: read CLAUDE.md"}),
    ) {
        Ok(op) => op,
        Err(_) => return HookOutput::default(),
    };
    // A kill or hard interrupt cancels the read like any hands call.
    let call = hands::call(agent, format!("ss-{}", uuid::Uuid::new_v4().simple()), op, agent.hands_token());
    // With a target cached the read itself is bounded; without one the call first waits for
    // AgentDO (the sandbox may still be placing), which takes as long as the resolve budget.
    let limit = match agent.hands_target() {
        Some(_) => rt.cfg.session_start_read_timeout,
        None => rt.cfg.session_start_read_timeout.max(hands::Budgets::default().not_ready),
    };
    let result = match tokio::time::timeout(limit, call).await {
        Ok(r) if !r.is_error => r,
        _ => return HookOutput::default(),
    };
    let text: String = result
        .content
        .iter()
        .filter_map(|c| match c {
            McpContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        return HookOutput::default();
    }
    HookOutput {
        hook_specific_output: Some(HookSpecificOutput::SessionStart {
            additional_context: Some(format!("The sandbox repository's CLAUDE.md (read through nest hands):\n\n{text}")),
        }),
        ..Default::default()
    }
}

/// A transcript path the tailer may follow: absolute, no `..`, under `<config_dir>/projects/`.
pub fn valid_transcript(agent: &Agent, p: &str) -> Option<std::path::PathBuf> {
    let path = std::path::Path::new(p);
    let clean = path.is_absolute() && path.components().all(|c| !matches!(c, std::path::Component::ParentDir));
    (clean && path.starts_with(agent.config_dir.join("projects")) && path.extension().is_some_and(|e| e == "jsonl"))
        .then(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::runtime::{AgentCmd, Outbound};
    use nest_protocol::control::{AgentCache, InboxMessage, ToolRule};
    use nest_protocol::model::{AgentEvent, AgentId, Epoch};
    use tokio::sync::mpsc;

    fn setup() -> (Arc<Runtime>, Arc<Agent>, mpsc::UnboundedReceiver<Outbound>, mpsc::UnboundedReceiver<AgentCmd>) {
        let rt = Runtime::new(Config::default());
        let (ctx, crx) = mpsc::unbounded_channel();
        let (otx, orx) = mpsc::unbounded_channel();
        let a = Agent::new(AgentId("agt_h".into()), Epoch(1), std::env::temp_dir(), None, vec![], 0, ctx, otx);
        assert!(rt.register(a.clone(), rt.fence_gen()).is_ok());
        (rt, a, orx, crx)
    }

    fn req(input: Value) -> HookDecisionRequest {
        HookDecisionRequest { v: 1, agent: AgentId("agt_h".into()), input }
    }

    fn cache(inbox: Vec<InboxMessage>) -> AgentCache {
        AgentCache {
            version: 1,
            rules: vec![
                ToolRule { pattern: "mcp__nest__Bash(git push --force*)".into(), decision: RuleDecision::Deny, reason: Some("no force".into()) },
                ToolRule { pattern: "mcp__nest__*".into(), decision: RuleDecision::Allow, reason: None },
            ],
            inbox,
            max_stop_continuations: 1,
        }
    }

    fn pre(output: &HookOutput) -> PermissionDecision {
        match &output.hook_specific_output {
            Some(HookSpecificOutput::PreToolUse { permission_decision: Some(d), .. }) => *d,
            o => panic!("{o:?}"),
        }
    }

    #[tokio::test]
    async fn pre_tool_use_rules_and_escalation() {
        let (rt, a, mut out, _c) = setup();
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Bash", "tool_input": {"command": "ls"}}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Deny, "no cache yet → deny");
        a.set_cache(cache(vec![]));
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Bash", "tool_input": {"command": "ls"}}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Allow);
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Bash", "tool_input": {"command": "git push --force"}}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Deny);
        // No rule for WebFetch → ask → escalation event + deny with "pending approval".
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "WebFetch", "tool_input": {"url": "https://x"}}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Deny);
        let mut saw_escalation = false;
        while let Ok(m) = out.try_recv() {
            if let Outbound::Event(AgentEvent { body: AgentEventBody::Escalation { tool, input, call }, .. }) = m {
                assert_eq!(tool, "WebFetch");
                assert_eq!(input["url"], "https://x");
                assert!(call.0.starts_with("cal_"));
                saw_escalation = true;
            }
        }
        assert!(saw_escalation);
        // An older cache version is ignored.
        let mut old = cache(vec![]);
        old.version = 0;
        old.rules.clear();
        a.set_cache(old);
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Read", "tool_input": {"file_path": "/x"}}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Allow);
    }

    #[tokio::test]
    async fn permission_request_maps_behavior() {
        let (rt, a, _o, _c) = setup();
        a.set_cache(cache(vec![]));
        let o = decide(&rt, &req(json!({"hook_event_name": "PermissionRequest", "tool_name": "mcp__nest__Bash", "tool_input": {"command": "ls"}}))).await.output;
        assert!(matches!(
            o.hook_specific_output,
            Some(HookSpecificOutput::PermissionRequest { decision: PermissionRequestDecision::Allow { .. } })
        ));
    }

    #[tokio::test]
    async fn unknown_agent_gets_fallback() {
        let rt = Runtime::new(Config::default());
        let o = decide(&rt, &req(json!({"hook_event_name": "PreToolUse", "tool_name": "x"}))).await.output;
        assert_eq!(pre(&o), PermissionDecision::Deny);
        let o = decide(&rt, &req(json!({"hook_event_name": "Stop"}))).await.output;
        assert_eq!(o, HookOutput::default());
    }

    #[test]
    fn transcript_paths_must_stay_in_the_config_dir() {
        let (_rt, a, _o, _c) = setup();
        let base = a.config_dir.join("projects");
        let ok = base.join("-x/u.jsonl");
        assert_eq!(valid_transcript(&a, ok.to_str().unwrap()), Some(ok.clone()));
        assert_eq!(valid_transcript(&a, "/etc/shadow"), None);
        assert_eq!(valid_transcript(&a, base.join("../../etc/x.jsonl").to_str().unwrap()), None);
        assert_eq!(valid_transcript(&a, base.join("-x/u.txt").to_str().unwrap()), None);
        assert_eq!(valid_transcript(&a, "projects/-x/u.jsonl"), None);
    }
}

#[cfg(test)]
mod session_start_tests {
    use super::*;
    use crate::config::Config;
    use crate::hands::SANDBOX_NOT_READY;
    use crate::runtime::{AgentCmd, Outbound};
    use nest_protocol::control::HandsOutcome;
    use crate::test_support::FakeGuest;
    use crate::test_support::gateway::TestGateway;
    use nest_protocol::control::HandsBinding;
    use nest_protocol::model::{AgentId, Epoch, ErrorBody, SandboxId};
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc;

    /// The SessionStart read on a sandbox that becomes ready 2 s after the brain starts: the
    /// hook's own read timeout (500 ms here) does not cut the wait for the target.
    #[tokio::test]
    async fn session_start_reads_claude_md_once_the_sandbox_is_ready() {
        let gw = TestGateway::start().await;
        let guest = FakeGuest::start().await;
        gw.add_sandbox("sbx_s", 2, &guest.path, &["agt_s"]);
        let rt = Runtime::new(Config { session_start_read_timeout: Duration::from_millis(500), ..Config::default() });
        let (ctx, _crx) = mpsc::unbounded_channel::<AgentCmd>();
        let (otx, mut orx) = mpsc::unbounded_channel::<Outbound>();
        let agent = Agent::new(
            AgentId("agt_s".into()),
            Epoch(2),
            std::env::temp_dir(),
            Some(HandsBinding { sandbox: SandboxId("sbx_s".into()), epoch: None }),
            vec![],
            0,
            ctx,
            otx,
        );
        // AgentDO: not ready for the first 2 s, then the target.
        let (a2, ready_at) = (agent.clone(), Instant::now() + Duration::from_secs(2));
        let target = gw.target("sbx_s", 2, "agt_s");
        tokio::spawn(async move {
            while let Some(o) = orx.recv().await {
                if let Outbound::HandsResolve(req) = o {
                    let outcome = if Instant::now() < ready_at {
                        HandsOutcome::Error {
                            error: ErrorBody { code: SANDBOX_NOT_READY.into(), message: "placing".into(), retryable: true },
                            retry_after_ms: Some(200),
                        }
                    } else {
                        HandsOutcome::Ok { hands: target.clone() }
                    };
                    a2.resolve_hands(&req, outcome);
                }
            }
        });
        let out = session_start(&rt, &agent, &json!({"transcript_path": "/nope"})).await;
        let ctx = out.hook_specific_output.map(|o| format!("{o:?}")).unwrap_or_default();
        assert!(ctx.contains("Project rules"), "CLAUDE.md was read through hands: {ctx}");
    }
}
