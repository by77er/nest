//! Brain lifecycle regressions (no real Claude Code: a shell script that never reads stdin).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nest_protocol::control::{self, LaunchConfig, SystemPrompt, TurnInput};
use nest_protocol::host::runner::{AgentStart, ExitReason, RunnerCommand, RunnerEvent};
use nest_protocol::model::{AgentId, AgentRole, TurnId, TurnInputKind, WorkstreamId};
use nest_runner::runtime::AgentCmd;
use nest_runner::{Config, Runtime};

const FAKE: &str = r#"#!/bin/sh
D=$(dirname "$0")
case "$1" in
  auth) [ -f "$D/slowauth" ] && sleep 2; echo '{"authMethod":"oauth_token"}'; exit 0;;
  --version) echo "2.1.296 (Claude Code)"; exit 0;;
esac
echo "$$" >> "$D/pids"
exec sleep 300
"#;

struct Env {
    dir: tempfile::TempDir,
    rt: Arc<Runtime>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("claude");
    std::fs::write(&fake, FAKE).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::create_dir_all(dir.path().join("empty")).unwrap();
    let cfg = Config { claude_bin: fake, cwd: dir.path().join("empty"), ..Config::default() };
    let rt = Runtime::new(cfg);
    *rt.lease.lock().unwrap() = Some(now_ms() + 600_000);
    Env { dir, rt }
}

fn start_cmd(dir: &Path, agent: &str, tools: &[&str]) -> RunnerCommand {
    let s = control::AgentStart {
        agent: AgentId(agent.into()),
        role: AgentRole::Captain,
        workstream: WorkstreamId("ws_t".into()),
        resume: None,
        hands: None,
        launch: LaunchConfig {
            model: None,
            effort: None,
            builtin_tools: tools.iter().map(|s| s.to_string()).collect(),
            system_prompt: SystemPrompt::Replace { text: "x".into() },
        },
        oauth_token: "tok-0123456789abcdef".into(),
        session_ws_url: "ws://127.0.0.1:1/x".into(),
    };
    RunnerCommand::AgentStart(Box::new(AgentStart { start: s, config_dir: dir.join(agent).display().to_string() }))
}

fn pids(dir: &Path) -> Vec<i32> {
    std::fs::read_to_string(dir.join("pids")).unwrap_or_default().lines().filter_map(|l| l.trim().parse().ok()).collect()
}

fn alive(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| !s.split(") ").nth(1).is_some_and(|r| r.starts_with('Z')))
}

/// Drain reported events (generation-tagged) for a moment.
async fn events(rt: &Runtime, wait: Duration) -> Vec<RunnerEvent> {
    let mut rx = rt.to_nestd_rx.lock().await;
    let mut out = Vec::new();
    let end = tokio::time::Instant::now() + wait;
    while let Ok(Some((_, ev))) = tokio::time::timeout_at(end, rx.recv()).await {
        out.push(ev);
    }
    out
}

/// Polls `f` for up to 15 s. The bound is a margin, not a timing claim: a GitHub runner has
/// taken more than 5 s to start the fake brain (a Python process) under load.
async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..300 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn exited(evs: &[RunnerEvent]) -> Vec<ExitReason> {
    evs.iter()
        .filter_map(|e| match e {
            RunnerEvent::AgentExited { reason, .. } => Some(*reason),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn duplicate_start_never_deregisters_the_live_brain() {
    let e = env();
    let id = AgentId("agt_dup".into());
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_dup", &[]));
    wait_for("first brain", || pids(e.dir.path()).len() == 1).await;
    let first = e.rt.agent(&id).expect("registered");
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_dup", &[]));
    let evs = events(&e.rt, Duration::from_millis(800)).await;
    assert!(exited(&evs).is_empty(), "a duplicate start must not report the brain as exited: {evs:?}");
    assert!(evs.iter().any(|ev| matches!(ev, RunnerEvent::Error { error, .. } if error.code == "already_running")));
    assert!(Arc::ptr_eq(&e.rt.agent(&id).expect("still registered"), &first));
    assert_eq!(pids(e.dir.path()).len(), 1, "no second Claude Code");
    // And it is still fenceable.
    e.rt.kill_all(ExitReason::Fenced);
    let pid = pids(e.dir.path())[0];
    wait_for("brain killed", || !alive(pid)).await;
    wait_for("deregistered", || e.rt.agent(&id).is_none()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fence_during_startup_cancels_it() {
    let e = env();
    std::fs::write(e.dir.path().join("slowauth"), "").unwrap();
    let id = AgentId("agt_slow".into());
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_slow", &[]));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(e.rt.agent(&id).is_some(), "registered before the slow auth step");
    nest_runner::supervisor::handle(&e.rt, RunnerCommand::Fence { agents: vec![], reason: "test".into() });
    let evs = events(&e.rt, Duration::from_secs(3)).await;
    assert_eq!(exited(&evs), [ExitReason::Fenced], "{evs:?}");
    assert!(e.rt.agent(&id).is_none());
    assert!(pids(e.dir.path()).is_empty(), "Claude Code was never spawned");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_brain_with_full_stdin_is_still_killed() {
    let e = env();
    let id = AgentId("agt_full".into());
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_full", &[]));
    wait_for("brain", || pids(e.dir.path()).len() == 1).await;
    let a = e.rt.agent(&id).unwrap();
    for i in 0..4 {
        a.command(AgentCmd::RunTurn { turn: TurnId(format!("trn_{i}")), input: TurnInput { kind: TurnInputKind::User, text: "x".repeat(1 << 20) } });
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    nest_runner::supervisor::handle(&e.rt, RunnerCommand::Fence { agents: vec![], reason: "test".into() });
    let pid = pids(e.dir.path())[0];
    wait_for("brain killed despite a full stdin", || !alive(pid)).await;
    wait_for("deregistered", || e.rt.agent(&id).is_none()).await;
    let evs = events(&e.rt, Duration::from_millis(500)).await;
    assert!(exited(&evs).contains(&ExitReason::Fenced), "{evs:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refuses_without_lease_and_with_host_tools() {
    let e = env();
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_tools", &["WebSearch", "Bash"]));
    let evs = events(&e.rt, Duration::from_millis(500)).await;
    assert!(evs.iter().any(|ev| matches!(ev, RunnerEvent::Error { error, .. } if error.code == "forbidden_tool")), "{evs:?}");
    assert_eq!(exited(&evs), [ExitReason::Crashed]);
    *e.rt.lease.lock().unwrap() = Some(now_ms() - 1);
    nest_runner::supervisor::handle(&e.rt, start_cmd(e.dir.path(), "agt_nolease", &[]));
    let evs = events(&e.rt, Duration::from_millis(500)).await;
    assert!(evs.iter().any(|ev| matches!(ev, RunnerEvent::Error { error, .. } if error.code == "no_lease")), "{evs:?}");
    assert!(pids(e.dir.path()).is_empty());
}

#[tokio::test]
async fn timed_out_platform_calls_are_abandoned_and_not_retryable() {
    use nest_runner::runtime::{Agent, Outbound};
    let (ctx, _crx) = tokio::sync::mpsc::unbounded_channel();
    let (otx, mut orx) = tokio::sync::mpsc::unbounded_channel();
    let a = Agent::new(AgentId("agt_p".into()), AgentRole::Worker, nest_protocol::model::Epoch(1), PathBuf::from("/tmp"), None, None, vec![], 0, ctx, otx);
    let r = a.platform_call("notify", serde_json::json!({"text": "x"}), Duration::from_millis(50)).await;
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["isError"], true, "{v}");
    assert!(v.to_string().contains("may or may not have taken effect"), "{v}");
    let mut sent = None;
    let mut abandoned = None;
    while let Ok(m) = orx.try_recv() {
        match m {
            Outbound::ToolCall { call, .. } => sent = Some(call),
            Outbound::AbandonCall(call) => abandoned = Some(call),
            _ => {}
        }
    }
    assert!(sent.is_some() && sent == abandoned);
}
