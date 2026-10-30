//! End-to-end: the real runner (in-process) + the real `nest` binary (hooks, MCP) + a fake
//! `claude` (tests/fake_claude.py) + fake nestd + mock AgentDO WebSocket + a real gateway
//! in-process + fake guest behind it. No real Claude Code and no credentials are ever used.
#![allow(clippy::result_large_err)] // tungstenite handshake callback signature

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::{
    self, AgentCache, AgentToRunner, HandsBinding, HandsOutcome, InboxMessage, LaunchConfig, RuleDecision, RunnerToAgent, SessionResume,
    SystemPrompt, ToolContent, ToolDef, ToolOutcome, ToolRule, TurnInput,
};
use nest_protocol::host::claude;
use nest_protocol::gateway::HandsTarget;
use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerCommand, RunnerEvent};
use nest_protocol::host::Secret;
use nest_protocol::model::{
    AgentEventBody, AgentId, Epoch, HostId, HostRole, MessageId, SandboxId, Seq, SessionId, TurnId, TurnInputKind,
    WorkstreamId,
};
use nest_runner::test_support::FakeGuest;
use nest_runner::test_support::gateway::TestGateway;
use nest_runner::{Config, Runtime};
use serde_json::{Value, json};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::Message;

const NEST_BIN: &str = env!("CARGO_BIN_EXE_nest");
const T: Duration = Duration::from_secs(20);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

// ------------------------------------------------------------------------------------------
// Fake nestd
// ------------------------------------------------------------------------------------------

struct FakeNestd {
    tx: mpsc::UnboundedSender<RunnerCommand>,
    rx: Mutex<mpsc::UnboundedReceiver<RunnerEvent>>,
    backlog: Mutex<Vec<RunnerEvent>>,
}

impl FakeNestd {
    async fn start(path: &Path) -> Arc<Self> {
        let listener = UnixListener::bind(path).unwrap();
        let (ctx, mut crx) = mpsc::unbounded_channel::<RunnerCommand>();
        let (etx, erx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let (mut rd, mut wr) = s.into_split();
            tokio::spawn(async move {
                while let Some(c) = crx.recv().await {
                    if nest_runner::framing::write_host(&mut wr, &c).await.is_err() {
                        break;
                    }
                }
            });
            while let Ok(Some(ev)) = nest_runner::framing::read_host::<_, RunnerEvent>(&mut rd).await {
                let _ = etx.send(ev);
            }
        });
        Arc::new(Self { tx: ctx, rx: Mutex::new(erx), backlog: Mutex::new(Vec::new()) })
    }

    fn send(&self, c: RunnerCommand) {
        self.tx.send(c).unwrap();
    }

    /// Wait for the first event matching `f`; unmatched events stay queued for later expects.
    async fn expect<R>(&self, what: &str, mut f: impl FnMut(&RunnerEvent) -> Option<R>) -> R {
        let mut rx = self.rx.lock().await;
        let mut backlog = self.backlog.lock().await;
        if let Some(i) = backlog.iter().position(|e| f(e).is_some()) {
            let ev = backlog.remove(i);
            return f(&ev).unwrap();
        }
        tokio::time::timeout(T, async {
            loop {
                let ev = rx.recv().await.expect("nestd channel closed");
                if let Some(r) = f(&ev) {
                    return r;
                }
                backlog.push(ev);
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for nestd event: {what}"))
    }
}

// ------------------------------------------------------------------------------------------
// Mock AgentDO (session channel)
// ------------------------------------------------------------------------------------------

#[derive(Default)]
struct DoLog {
    authorization: Vec<String>,
    hellos: Vec<control::RunnerHello>,
    resolves: usize,
    events: Vec<nest_protocol::model::AgentEvent>,
    tool_calls: Vec<control::ToolCall>,
    segments: Vec<(u64, bool, Vec<u8>)>,
}

struct MockDo {
    url: String,
    log: Arc<Mutex<DoLog>>,
    to_runner: Arc<Mutex<Option<mpsc::UnboundedSender<AgentToRunner>>>>,
    /// What `hands_resolve` is answered with (set once the gateway exists).
    hands: Arc<Mutex<Option<HandsTarget>>>,
    seq: std::sync::atomic::AtomicU64,
}

impl MockDo {
    async fn start() -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/agents/agt_e2e/session", listener.local_addr().unwrap());
        let log: Arc<Mutex<DoLog>> = Default::default();
        let to_runner: Arc<Mutex<Option<mpsc::UnboundedSender<AgentToRunner>>>> = Default::default();
        let hands: Arc<Mutex<Option<HandsTarget>>> = Default::default();
        let (log2, tr2, hands2) = (log.clone(), to_runner.clone(), hands.clone());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (log, tr, hands) = (log2.clone(), tr2.clone(), hands2.clone());
                tokio::spawn(async move {
                    let auth = Arc::new(std::sync::Mutex::new(String::new()));
                    let a2 = auth.clone();
                    let ws = tokio_tungstenite::accept_hdr_async(tcp, move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                        *a2.lock().unwrap() = req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                        Ok(resp)
                    })
                    .await
                    .unwrap();
                    log.lock().await.authorization.push(auth.lock().unwrap().clone());
                    let (mut wtx, mut wrx) = ws.split();
                    let (tx, mut rx) = mpsc::unbounded_channel::<AgentToRunner>();
                    *tr.lock().await = Some(tx.clone());
                    tokio::spawn(async move {
                        while let Some(m) = rx.recv().await {
                            if wtx.send(Message::Text(serde_json::to_string(&m).unwrap().into())).await.is_err() {
                                break;
                            }
                        }
                    });
                    while let Some(Ok(m)) = wrx.next().await {
                        let Message::Text(t) = m else { continue };
                        let msg: RunnerToAgent = serde_json::from_str(&t).unwrap();
                        let mut l = log.lock().await;
                        match msg {
                            RunnerToAgent::Hello(h) => {
                                l.hellos.push(h);
                                let _ = tx.send(AgentToRunner::HelloAck { protocol_version: 1, durable_bytes: 0, last_seq: None });
                            }
                            RunnerToAgent::Segment { offset, base, data_b64, session } => {
                                let data = base64::engine::general_purpose::STANDARD.decode(data_b64).unwrap();
                                let end = offset + data.len() as u64;
                                l.segments.push((offset, base, data));
                                let _ = tx.send(AgentToRunner::SegmentAck { session, durable_bytes: end });
                            }
                            RunnerToAgent::Events { seq, events } => {
                                l.events.extend(events);
                                let _ = tx.send(AgentToRunner::Ack { up_to: seq });
                            }
                            RunnerToAgent::ToolCall(c) => {
                                let outcome = match c.name.as_str() {
                                    "notify" => ToolOutcome::Ok { content: vec![ToolContent::Text { text: "Notified captain.".into() }] },
                                    _ => ToolOutcome::Pending { ask: nest_protocol::model::AskId("ask_1".into()), message: "Question posted.".into() },
                                };
                                let _ = tx.send(AgentToRunner::Ack { up_to: c.seq });
                                let _ = tx.send(AgentToRunner::ToolResult { seq: Seq(900 + c.seq.0), call: c.call.clone(), outcome });
                                l.tool_calls.push(c);
                            }
                            RunnerToAgent::ToolsListRequest { request } => {
                                let _ = tx.send(AgentToRunner::ToolsList { request, tools: vec![notify_tool()] });
                            }
                            RunnerToAgent::HandsResolve { request } => {
                                l.resolves += 1;
                                let outcome = match hands.lock().await.clone() {
                                    Some(hands) => HandsOutcome::Ok { hands },
                                    None => HandsOutcome::Error {
                                        error: nest_protocol::model::ErrorBody {
                                            code: "not_bound".into(),
                                            message: "no sandbox in this test".into(),
                                            retryable: false,
                                        },
                                        retry_after_ms: None,
                                    },
                                };
                                let _ = tx.send(AgentToRunner::HandsResolved {
                                    request,
                                    outcome: Some(Box::new(outcome)),
                                    hands: None,
                                    error: None,
                                    retry_after_ms: None,
                                });
                            }
                            RunnerToAgent::CancelCall { seq, .. } => {
                                let _ = tx.send(AgentToRunner::Ack { up_to: seq });
                            }
                            RunnerToAgent::Ack { .. } => {}
                        }
                    }
                });
            }
        });
        Arc::new(Self { url, log, to_runner, hands, seq: std::sync::atomic::AtomicU64::new(0) })
    }

    async fn send(&self, f: impl FnOnce(Seq) -> AgentToRunner) {
        let seq = Seq(self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1);
        let deadline = tokio::time::Instant::now() + T;
        loop {
            if let Some(tx) = self.to_runner.lock().await.clone() {
                tx.send(f(seq)).unwrap();
                return;
            }
            assert!(tokio::time::Instant::now() < deadline, "no session connection");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_for<R>(&self, what: &str, mut f: impl FnMut(&DoLog) -> Option<R>) -> R {
        let deadline = tokio::time::Instant::now() + T;
        loop {
            if let Some(r) = f(&*self.log.lock().await) {
                return r;
            }
            assert!(tokio::time::Instant::now() < deadline, "timed out waiting for AgentDO: {what}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn transcript(&self) -> String {
        let l = self.log.lock().await;
        let mut buf: Vec<u8> = Vec::new();
        for (off, base, data) in &l.segments {
            if *base {
                buf.clear();
            }
            assert_eq!(*off as usize, buf.len(), "segments must be contiguous");
            buf.extend_from_slice(data);
        }
        String::from_utf8(buf).unwrap()
    }
}

fn notify_tool() -> ToolDef {
    ToolDef {
        name: "notify".into(),
        description: "Send a message.".into(),
        input_schema: json!({"type": "object", "properties": {"to": {"type": "string"}, "message": {"type": "string"}}, "required": ["to", "message"], "additionalProperties": false}),
        roles: None,
        requires_approval: false,
    }
}

// ------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------

struct Harness {
    dir: tempfile::TempDir,
    nestd: Arc<FakeNestd>,
    agentdo: Arc<MockDo>,
    guest: FakeGuest,
    _gateway: TestGateway,
    runner: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.runner.abort();
    }
}

const AGENT: &str = "agt_e2e";
const OAUTH: &str = "oauth-secret-token-0123456789";

impl Harness {
    async fn new(idle_grace: Duration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("claude");
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_claude.py"), &fake).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cwd = dir.path().join("empty");
        std::fs::create_dir_all(&cwd).unwrap();
        let nestd = FakeNestd::start(&dir.path().join("runner.sock")).await;
        let cfg = Config {
            nestd_sock: dir.path().join("runner.sock"),
            hook_dgram: dir.path().join("run/hook.dgram"),
            hook_sock: dir.path().join("run/hook.sock"),
            mcp_sock: dir.path().join("run/mcp.sock"),
            claude_bin: fake,
            nest_bin: NEST_BIN.into(),
            cwd,
            idle_grace,
            batch_interval: Duration::from_millis(100),
            tail_interval: Duration::from_millis(50),
            interrupt_grace: Duration::from_secs(5),
            tools_list_timeout: Duration::from_secs(5),
            ..Config::default()
        };
        let runner = tokio::spawn(nest_runner::serve(Runtime::new(cfg)));
        nestd.expect("hello", |e| matches!(e, RunnerEvent::Hello { .. }).then_some(())).await;
        nestd.send(RunnerCommand::HelloAck { protocol_version: 1, host_id: HostId("hst_test".into()), host_role: HostRole::Sandbox });
        nestd.send(RunnerCommand::HostToken { token: Secret("host-token-abc".into()), expires_ms: now_ms() + 3_600_000 });
        nestd.send(RunnerCommand::LeaseUpdate { valid_until_ms: now_ms() + 600_000 });
        let agentdo = MockDo::start().await;
        let guest = FakeGuest::start().await;
        // The sandbox lives behind a real gateway; AgentDO's `hands_resolved` names it.
        let gateway = TestGateway::start().await;
        gateway.add_sandbox("sbx_e2e", 7, &guest.path, &[AGENT]);
        *agentdo.hands.lock().await = Some(gateway.target("sbx_e2e", 7, AGENT));
        Self { dir, nestd, agentdo, guest, _gateway: gateway, runner }
    }

    fn config_dir(&self) -> PathBuf {
        self.dir.path().join("agents").join(AGENT)
    }

    fn start_agent(&self, oauth: &str, resume: Option<SessionResume>) {
        let start = control::AgentStart {
            agent: AgentId(AGENT.into()),
            role: None,
            workstream: WorkstreamId("ws_e2e".into()),
            // The agent epoch (3) is unrelated to the sandbox's (7, inside the binding).
            epoch: Some(Epoch(3)),
            resume,
            hands: Some(HandsBinding { sandbox: SandboxId("sbx_e2e".into()), epoch: None }),
            launch: LaunchConfig {
                model: None,
                effort: Some("high".into()),
                builtin_tools: claude::WORKER_BUILTIN_TOOLS.iter().map(|s| s.to_string()).collect(),
                system_prompt: SystemPrompt::Append { text: "You are a nest worker.".into() },
            },
            oauth_token: oauth.into(),
            session_ws_url: self.agentdo.url.clone(),
        };
        self.nestd.send(RunnerCommand::AgentStart(Box::new(AgentStart {
            start,
            config_dir: self.config_dir().to_string_lossy().into_owned(),
        })));
    }

    async fn send_cache(&self, inbox: Vec<InboxMessage>) {
        let cache = AgentCache {
            version: 1,
            rules: vec![ToolRule { pattern: "mcp__nest__*".into(), decision: RuleDecision::Allow, reason: None }],
            inbox,
            max_stop_continuations: 2,
        };
        self.agentdo.send(|seq| AgentToRunner::CacheUpdate { seq, cache }).await;
    }

    async fn run_turn(&self, turn: &str, text: &str) {
        let (turn, text) = (TurnId(turn.into()), text.to_string());
        self.agentdo.send(|seq| AgentToRunner::RunTurn { seq, turn, input: TurnInput { kind: TurnInputKind::User, text } }).await;
    }

    fn runs(&self) -> Vec<Value> {
        let p = self.config_dir().join("fake-claude-runs.jsonl");
        std::fs::read_to_string(p).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }
}

fn turn_completed(l: &DoLog, turn: &str) -> Option<String> {
    l.events.iter().find_map(|e| match &e.body {
        AgentEventBody::TurnCompleted { stop_reason, .. } if e.turn.as_ref().map(|t| t.0.as_str()) == Some(turn) => Some(stop_reason.clone()),
        _ => None,
    })
}

// ------------------------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_with_hands_platform_tool_inbox_and_idle_exit() {
    let h = Harness::new(Duration::from_millis(800)).await;
    h.start_agent(OAUTH, None);

    let (auth_method, api_key_source, ok) = h
        .nestd
        .expect("auth_check", |e| match e {
            RunnerEvent::AuthCheck { auth_method, api_key_source, ok, .. } => Some((auth_method.clone(), api_key_source.clone(), *ok)),
            _ => None,
        })
        .await;
    assert_eq!((auth_method.as_str(), api_key_source.as_str(), ok), ("oauth_token", "none", true));

    let hello = h.agentdo.wait_for("hello", |l| l.hellos.first().cloned()).await;
    assert_eq!((hello.agent.0.as_str(), hello.epoch, hello.host.0.as_str()), (AGENT, Epoch(3), "hst_test"));
    assert_eq!(h.agentdo.log.lock().await.authorization[0], "Bearer host-token-abc");

    let started = h
        .nestd
        .expect("agent_started", |e| match e {
            RunnerEvent::AgentStarted { session, claude_version, .. } => Some((session.clone(), claude_version.clone())),
            _ => None,
        })
        .await;
    assert!(started.0.0.starts_with("ses_") && started.1 == "2.1.296");

    let inbox_msg = InboxMessage { id: MessageId("msg_1".into()), from: "user".into(), text: "please also run the tests".into(), interrupt: false, ts_ms: 0 };
    h.send_cache(vec![inbox_msg]).await;
    h.run_turn("trn_one", "PLATFORM hello").await;

    let stop = h.agentdo.wait_for("turn_completed", |l| turn_completed(l, "trn_one")).await;
    assert_eq!(stop, "end_turn");

    // Canonical events for the turn, in order.
    {
        let l = h.agentdo.log.lock().await;
        let kinds: Vec<&str> = l
            .events
            .iter()
            .filter(|e| e.turn.as_ref().map(|t| t.0.as_str()) == Some("trn_one"))
            .filter_map(|e| match &e.body {
                AgentEventBody::TurnStarted { .. } => Some("turn_started"),
                AgentEventBody::ToolCall { .. } => Some("tool_call"),
                AgentEventBody::ToolResult { .. } => Some("tool_result"),
                AgentEventBody::AssistantText { .. } => Some("text"),
                AgentEventBody::TurnCompleted { .. } => Some("turn_completed"),
                _ => None,
            })
            .collect();
        // Step 1: Bash + notify + text; Stop hook delivers the inbox → step 2: Bash + text.
        assert_eq!(
            kinds,
            ["turn_started", "tool_call", "tool_result", "tool_call", "tool_result", "text", "tool_call", "tool_result", "text", "turn_completed"]
        );
        let seqs: Vec<u64> = l.events.iter().map(|e| e.seq.0).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]), "event seqs increase: {seqs:?}");
        assert!(l.events.iter().all(|e| e.epoch == Epoch(3) && e.agent.0 == AGENT));
        // The platform tool went through the relay with a cal_<turn>-<n> id.
        let call = &l.tool_calls[0];
        assert_eq!(call.name, "notify");
        assert!(call.call.0.starts_with("cal_trnone-"), "{}", call.call);
    }

    // Hands: SessionStart read CLAUDE.md, then the two turn steps.
    let reqs = h.guest.requests().await;
    let cmds: Vec<String> = reqs
        .iter()
        .map(|r| match &r.op {
            nest_protocol::guest::HandsOp::Bash(b) => b.command.clone(),
            o => o.tool_name().into(),
        })
        .collect();
    assert!(cmds[0].contains("CLAUDE.md"), "{cmds:?}");
    assert_eq!(h.agentdo.log.lock().await.resolves, 1, "one hands_resolve serves the hook read and both turn steps");
    assert!(cmds.iter().any(|c| c == "echo PLATFORM hello"), "{cmds:?}");
    assert!(cmds.iter().any(|c| c.starts_with("echo New messages arrived")), "{cmds:?}");
    // Hands requests carry the sandbox epoch from the binding, not the agent epoch.
    assert!(reqs.iter().all(|r| r.epoch == Epoch(7) && r.agent_id.0 == AGENT));

    // Session file streamed contiguously, redacted, and complete.
    h.agentdo.wait_for("transcript", |l| (!l.segments.is_empty()).then_some(())).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t = h.agentdo.transcript().await;
    assert!(t.contains("PLATFORM hello") && t.contains("please also run the tests"), "{t}");
    assert!(!t.contains(OAUTH));

    // Idle grace → stdin closed → clean exit reported as idle.
    let reason = h
        .nestd
        .expect("agent_exited", |e| match e {
            RunnerEvent::AgentExited { reason, .. } => Some(*reason),
            _ => None,
        })
        .await;
    assert_eq!(reason, ExitReason::Idle);

    // What Claude Code saw: exact flags, a clean env, hooks and MCP wired up.
    let runs = h.runs();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    let argv: Vec<&str> = run["argv"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    for f in ["-p", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--session-id", "--append-system-prompt-file"] {
        assert!(argv.contains(&f), "missing {f} in {argv:?}");
    }
    assert!(!argv.contains(&"--bare") && !argv.contains(&"--safe-mode"));
    let tools_i = argv.iter().position(|a| *a == "--tools").unwrap();
    assert_eq!(argv[tools_i + 1], claude::WORKER_BUILTIN_TOOLS.join(","));
    let env = run["env"].as_object().unwrap();
    assert_eq!(env["CLAUDE_CODE_OAUTH_TOKEN"], OAUTH);
    assert_eq!(env["NEST_AGENT_ID"], AGENT);
    assert_eq!(env["HOME"].as_str().unwrap(), h.config_dir().to_str().unwrap());
    assert!(!env.keys().any(|k| k.starts_with("ANTHROPIC_") || k.starts_with("CARGO")), "inherited env leaked: {:?}", env.keys());
    let events = run["events"].as_array().unwrap();
    let ctx = events
        .iter()
        .find(|e| e["kind"] == "hook" && e["event"] == "SessionStart")
        .map(|e| e["output"]["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or_default().to_string())
        .unwrap();
    assert!(ctx.contains("# Project rules"), "{ctx}");
    let tools = events.iter().find(|e| e["kind"] == "tool").map(|_| ()).is_some();
    assert!(tools);
    let names: Vec<&str> = events.iter().find(|e| e["kind"] == "tools").unwrap()["names"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(names, ["Bash", "TaskOutput", "TaskStop", "Read", "Write", "Edit", "Glob", "Grep", "notify"]);
    let notify = events.iter().find(|e| e["kind"] == "tool" && e["name"] == "notify").unwrap();
    assert_eq!(notify["text"], "Notified captain.");
    assert!(events.iter().all(|e| e["kind"] != "hook" || e["exit"] == 0), "nest hook always exits 0");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resume_argv_and_interrupt_cancels_hands() {
    let h = Harness::new(Duration::from_secs(30)).await;
    // A complete local session file: no download needed, `--resume <path>`.
    let uuid = "5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
    let path = nest_runner::agent::transcript_path(&h.config_dir(), &h.dir.path().join("empty"), uuid);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let prior = "{\"type\":\"user\",\"message\":\"earlier\"}\n";
    std::fs::write(&path, prior).unwrap();
    let resume = SessionResume { session: SessionId(format!("ses_{uuid}")), segments: vec![], total_bytes: prior.len() as u64, fork: false };
    h.start_agent(OAUTH, Some(resume));
    h.agentdo.wait_for("hello", |l| l.hellos.first().cloned()).await;
    assert_eq!(h.agentdo.log.lock().await.hellos[0].session.as_ref().unwrap().0, format!("ses_{uuid}"));
    h.send_cache(vec![]).await;
    h.run_turn("trn_slow", "SLOW job").await;

    // Wait until the Bash call is running in the guest, then interrupt.
    let deadline = tokio::time::Instant::now() + T;
    while !h.guest.requests().await.iter().any(|r| matches!(&r.op, nest_protocol::guest::HandsOp::Bash(b) if b.command == "sleep 30")) {
        assert!(tokio::time::Instant::now() < deadline, "sleep never reached the guest");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    h.agentdo.send(|seq| AgentToRunner::Interrupt { seq, turn: Some(TurnId("trn_slow".into())) }).await;
    let stop = h.agentdo.wait_for("turn_completed", |l| turn_completed(l, "trn_slow")).await;
    assert_eq!(stop, "interrupted");
    assert_eq!(h.guest.cancelled().await.len(), 1, "the in-flight hands call was cancelled");

    // Stop the agent so the fake writes its run log.
    h.nestd.send(RunnerCommand::AgentStop { agent: AgentId(AGENT.into()), mode: nest_protocol::host::runner::StopMode::Graceful, reason: "test".into(), epoch: None });
    let reason = h.nestd.expect("exit", |e| if let RunnerEvent::AgentExited { reason, .. } = e { Some(*reason) } else { None }).await;
    assert_eq!(reason, ExitReason::Stopped);
    let runs = h.runs();
    let argv: Vec<&str> = runs[0]["argv"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let i = argv.iter().position(|a| *a == "--resume").expect("--resume");
    assert_eq!(argv[i + 1], path.to_str().unwrap());
    assert!(!argv.contains(&"--session-id"));
    // The resumed file is streamed from offset 0 and includes the earlier line.
    h.agentdo.wait_for("segments", |l| l.segments.iter().any(|(o, _, _)| *o == 0).then_some(())).await;
    assert!(h.agentdo.transcript().await.starts_with(prior));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lease_lapse_kills_brains() {
    let h = Harness::new(Duration::from_secs(30)).await;
    h.start_agent(OAUTH, None);
    h.nestd.expect("started", |e| matches!(e, RunnerEvent::AgentStarted { .. }).then_some(())).await;
    h.nestd.send(RunnerCommand::LeaseUpdate { valid_until_ms: now_ms() - 1 });
    let reason = h.nestd.expect("exit", |e| if let RunnerEvent::AgentExited { reason, .. } = e { Some(*reason) } else { None }).await;
    assert_eq!(reason, ExitReason::Fenced);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn non_oauth_auth_refuses_to_run() {
    let h = Harness::new(Duration::from_secs(30)).await;
    h.start_agent("apikey-not-a-subscription", None);
    let ok = h.nestd.expect("auth_check", |e| if let RunnerEvent::AuthCheck { ok, auth_method, .. } = e { Some((*ok, auth_method.clone())) } else { None }).await;
    assert_eq!(ok, (false, "api_key".to_string()));
    let reason = h.nestd.expect("exit", |e| if let RunnerEvent::AgentExited { reason, .. } = e { Some(*reason) } else { None }).await;
    assert_eq!(reason, ExitReason::AuthFailed);
    assert!(h.runs().is_empty(), "claude must not run a session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn api_key_source_in_init_kills_agent() {
    let h = Harness::new(Duration::from_secs(30)).await;
    h.start_agent("apisrc-oauth-but-api-key-env", None);
    let check = h.nestd.expect("auth_check", |e| if let RunnerEvent::AuthCheck { ok, api_key_source, .. } = e { Some((*ok, api_key_source.clone())) } else { None }).await;
    assert_eq!(check, (false, "ANTHROPIC_API_KEY".to_string()));
    let reason = h.nestd.expect("exit", |e| if let RunnerEvent::AgentExited { reason, .. } = e { Some(*reason) } else { None }).await;
    assert_eq!(reason, ExitReason::AuthFailed);
}

// ------------------------------------------------------------------------------------------
// `nest hook` without a runner
// ------------------------------------------------------------------------------------------

fn nest_hook(sync: bool, input: Value, env: &[(&str, &str)]) -> (i32, String) {
    use std::io::Write;
    let mut cmd = std::process::Command::new(NEST_BIN);
    cmd.arg("hook");
    if sync {
        cmd.arg("--sync");
    }
    let mut child = cmd
        .env_clear()
        .envs(env.iter().copied())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap(), String::from_utf8(out.stdout).unwrap())
}

#[test]
fn hook_fallbacks_and_spool_without_runner() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("missing.sock");
    let spool = dir.path().join("spool.jsonl");
    let env = [
        ("NEST_AGENT_ID", "agt_x"),
        ("NEST_HOOK_SOCK", sock.to_str().unwrap()),
        ("NEST_HOOK_DGRAM", sock.to_str().unwrap()),
        ("NEST_HOOK_SPOOL", spool.to_str().unwrap()),
    ];
    let (code, out) = nest_hook(true, json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Bash"}), &env);
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
    let (code, out) = nest_hook(true, json!({"hook_event_name": "Stop"}), &env);
    assert_eq!((code, out.as_str()), (0, ""));
    let (code, _) = nest_hook(false, json!({"hook_event_name": "PostToolUse", "tool_response": "x".repeat(100_000)}), &env);
    assert_eq!(code, 0);
    let line = std::fs::read_to_string(&spool).unwrap();
    let d: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!((d["agent"].as_str(), d["truncated"].as_bool()), (Some("agt_x"), Some(true)));
}

// ------------------------------------------------------------------------------------------
// Review regressions
// ------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn turn_arriving_during_idle_exit_resumes_claude_code() {
    let h = Harness::new(Duration::from_millis(300)).await;
    std::fs::create_dir_all(h.config_dir()).unwrap();
    // The fake lingers after stdin EOF, like a real Claude Code finishing up.
    std::fs::write(h.config_dir().join("fake-exit-delay-ms"), "1500").unwrap();
    h.start_agent(OAUTH, None);
    h.nestd.expect("started", |e| matches!(e, RunnerEvent::AgentStarted { .. }).then_some(())).await;
    h.send_cache(vec![]).await;
    h.run_turn("trn_a", "first").await;
    h.agentdo.wait_for("turn a", |l| turn_completed(l, "trn_a")).await;
    // Idle grace passes → stdin is closed while the process is still exiting; then a turn.
    tokio::time::sleep(Duration::from_millis(700)).await;
    h.run_turn("trn_b", "second").await;
    let stop = h.agentdo.wait_for("turn b", |l| turn_completed(l, "trn_b")).await;
    assert_eq!(stop, "end_turn", "the late turn ran instead of being dropped");
    // Eventually idle again: exactly one exit is reported, after both runs.
    let reason = h.nestd.expect("exit", |e| if let RunnerEvent::AgentExited { reason, .. } = e { Some(*reason) } else { None }).await;
    assert_eq!(reason, ExitReason::Idle);
    let runs = h.runs();
    assert_eq!(runs.len(), 2, "{runs:?}");
    let argv: Vec<&str> = runs[1]["argv"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let i = argv.iter().position(|a| *a == "--resume").expect("second run resumes");
    assert!(argv[i + 1].ends_with(".jsonl"));
    assert_eq!(runs[0]["session"], runs[1]["session"], "same session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hooks_from_outside_the_brain_get_the_fallback() {
    let h = Harness::new(Duration::from_secs(30)).await;
    h.start_agent(OAUTH, None);
    h.nestd.expect("started", |e| matches!(e, RunnerEvent::AgentStarted { .. }).then_some(())).await;
    h.send_cache(vec![]).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // This test process claims to be the agent's hook: the rules would allow it, but the peer
    // isn't a descendant of that agent's Claude Code, so the runner answers with the fallback.
    let sock = h.dir.path().join("run/hook.sock").to_string_lossy().into_owned();
    let input = json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__Bash", "tool_input": {"command": "ls"}});
    let (code, out) = tokio::task::spawn_blocking(move || nest_hook(true, input, &[("NEST_AGENT_ID", AGENT), ("NEST_HOOK_SOCK", &sock)]))
        .await
        .unwrap();
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny", "{v}");
}
