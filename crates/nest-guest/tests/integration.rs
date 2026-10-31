//! End-to-end tests over the unix-socket vsock emulation (no KVM, unprivileged).

use std::path::{Path, PathBuf};
use std::time::Duration;

use nest_guest::framed::{FramedReader, parse_json, write_data, write_json};
use nest_guest::transport::emulator::{self, Emulator};
use nest_guest::{Config, ListenSpec};
use nest_protocol::guest::frame::Kind;
use nest_protocol::guest::*;
use nest_protocol::model::{AgentId, Epoch, SandboxId};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::{TcpListener, UnixStream};

const AGENT: &str = "agt_test1";
const EPOCH: u64 = 7;

struct Harness {
    tmp: tempfile::TempDir,
    _running: nest_guest::Running,
    _emu: Emulator,
    socket: PathBuf,
    ws: PathBuf,
    cli: PathBuf,
}

async fn harness() -> Harness {
    let tmp = tempfile::tempdir().unwrap();
    let ports = tmp.path().join("ports");
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let cli = tmp.path().join("guest.sock");
    let mut config = Config::for_listen(ListenSpec::Unix(ports.clone()));
    config.state_dir = tmp.path().join("state");
    config.cgroup_root = None;
    config.cli_socket = Some(cli.clone());
    config.port_poll = Duration::from_millis(100);
    config.run_as = None;
    config.disk_mounts = vec![tmp.path().to_path_buf()];
    let running = nest_guest::start(config).await.unwrap();
    let socket = tmp.path().join("vsock.sock");
    let emu = Emulator::start(&socket, &ports).unwrap();
    Harness { tmp, _running: running, _emu: emu, socket, ws, cli }
}

struct Control {
    r: FramedReader<ReadHalf<UnixStream>>,
    w: WriteHalf<UnixStream>,
    backlog: Vec<ControlFrame>,
    next_id: u64,
}

impl Control {
    async fn open(h: &Harness) -> (Control, ControlFrame) {
        let s = emulator::connect(&h.socket, PORT_CONTROL).await.unwrap();
        let (r, w) = tokio::io::split(s);
        let mut c = Control { r: FramedReader::new(r), w, backlog: vec![], next_id: 100 };
        let hello = c.read().await;
        (c, hello)
    }

    async fn read(&mut self) -> ControlFrame {
        let f = tokio::time::timeout(Duration::from_secs(10), self.r.next()).await.expect("control timeout").unwrap().unwrap();
        parse_json(&f).unwrap()
    }

    async fn request(&mut self, body: ControlBody) -> ControlBody {
        self.next_id += 1;
        let id = self.next_id;
        write_json(&mut self.w, &ControlFrame { id: Some(id), reply_to: None, body }).await.unwrap();
        loop {
            let f = self.read().await;
            if f.reply_to == Some(id) {
                return f.body;
            }
            self.backlog.push(f);
        }
    }

    async fn event(&mut self, mut pred: impl FnMut(&ControlFrame) -> bool) -> ControlFrame {
        if let Some(i) = self.backlog.iter().position(&mut pred) {
            return self.backlog.remove(i);
        }
        loop {
            let f = self.read().await;
            if pred(&f) {
                return f;
            }
        }
    }

    async fn configure(&mut self, ws: &Path) {
        let body = ControlBody::Configure {
            sandbox_id: SandboxId("sbx_test".into()),
            epoch: Epoch(EPOCH),
            hostname: "sbx-test".into(),
            agents: vec![slot(ws)],
        };
        assert_eq!(self.request(body).await, ControlBody::Ok {});
    }
}

fn slot(ws: &Path) -> AgentSlot {
    AgentSlot {
        agent_id: AgentId(AGENT.into()),
        proxy_port: 3129,
        cwd: ws.display().to_string(),
        env: [("CI".to_string(), "1".to_string())].into(),
        memory_max_bytes: None,
    }
}

async fn configured() -> (Harness, Control) {
    let h = harness().await;
    let (mut c, _) = Control::open(&h).await;
    c.configure(&h.ws).await;
    (h, c)
}

fn request(call_id: &str, op: serde_json::Value) -> HandsRequest {
    HandsRequest {
        protocol_version: PROTOCOL_VERSION,
        call_id: call_id.into(),
        agent_id: AgentId(AGENT.into()),
        epoch: Epoch(EPOCH),
        op: serde_json::from_value(op).unwrap(),
    }
}

/// Run one hands call to completion; returns every response frame.
async fn call_raw(h: &Harness, req: &HandsRequest) -> Vec<HandsResponse> {
    let s = emulator::connect(&h.socket, PORT_HANDS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    write_json(&mut w, req).await.unwrap();
    let mut r = FramedReader::new(r);
    let mut out = vec![];
    while let Some(f) = tokio::time::timeout(Duration::from_secs(20), r.next()).await.expect("hands timeout").unwrap() {
        out.push(parse_json(&f).unwrap());
    }
    out
}

async fn call(h: &Harness, call_id: &str, op: serde_json::Value) -> HandsResult {
    let resps = call_raw(h, &request(call_id, op)).await;
    match resps.into_iter().last() {
        Some(HandsResponse::Result { result, .. }) => result,
        other => panic!("expected result, got {other:?}"),
    }
}

fn text_of(r: &HandsResult) -> String {
    r.content
        .iter()
        .filter_map(|c| match c {
            ToolContent::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn pid_alive(pid: i32) -> bool {
    // A zombie still "exists"; treat it as dead.
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => !s.split(") ").nth(1).is_some_and(|rest| rest.starts_with('Z')),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn hello_then_busy_until_configured() {
    let h = harness().await;
    let (mut c, hello) = Control::open(&h).await;
    match hello.body {
        ControlBody::Hello { protocol_version, boot_id, instance_id, capabilities, .. } => {
            assert_eq!(protocol_version, PROTOCOL_VERSION);
            assert!(!boot_id.is_empty());
            assert_eq!(instance_id.len(), 16);
            assert!(capabilities.contains(&"pty".to_string()));
        }
        other => panic!("first frame must be hello, got {other:?}"),
    }
    let resps = call_raw(&h, &request("c1", json!({"tool": "Bash", "command": "true"}))).await;
    match &resps[..] {
        [HandsResponse::Error { error, .. }] => {
            assert_eq!(error.code, "busy");
            assert!(error.retryable);
        }
        other => panic!("{other:?}"),
    }
    c.configure(&h.ws).await;
    // After configure the guest re-announces ports.
    c.event(|f| matches!(f.body, ControlBody::Ports { .. })).await;
    assert!(!call(&h, "c2", json!({"tool": "Bash", "command": "true"})).await.is_error);
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_epoch_unknown_agent_and_version() {
    let (h, _c) = configured().await;
    let mut req = request("c1", json!({"tool": "Bash", "command": "true"}));
    req.epoch = Epoch(6);
    assert!(matches!(&call_raw(&h, &req).await[..], [HandsResponse::Error { error, .. }] if error.code == "stale_epoch"));
    let mut req = request("c2", json!({"tool": "Bash", "command": "true"}));
    req.agent_id = AgentId("agt_nobody".into());
    assert!(matches!(&call_raw(&h, &req).await[..], [HandsResponse::Error { error, .. }] if error.code == "unknown_agent"));
    let mut req = request("c3", json!({"tool": "Bash", "command": "true"}));
    req.protocol_version = 99;
    assert!(
        matches!(&call_raw(&h, &req).await[..], [HandsResponse::Error { error, .. }] if error.code == "unsupported_version")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_persistent_cwd_env_and_started() {
    let (h, _c) = configured().await;
    let resps = call_raw(&h, &request("b1", json!({"tool": "Bash", "command": "mkdir -p sub/deeper && cd sub"}))).await;
    assert!(matches!(resps[0], HandsResponse::Started { .. }), "{resps:?}");
    let r = call(&h, "b2", json!({"tool": "Bash", "command": "pwd; export FOO=bar"})).await;
    assert_eq!(text_of(&r).trim(), h.ws.join("sub").display().to_string());
    match &r.detail {
        HandsDetail::Bash { cwd, exit_code, output_path, .. } => {
            assert_eq!(cwd, &h.ws.join("sub").display().to_string());
            assert_eq!(*exit_code, Some(0));
            assert!(Path::new(output_path).exists());
        }
        d => panic!("{d:?}"),
    }
    // Exported variables do not persist; agent env does.
    let r = call(&h, "b3", json!({"tool": "Bash", "command": "echo \"[$FOO] $NEST_AGENT_ID $HTTPS_PROXY $CI\""})).await;
    assert_eq!(text_of(&r).trim(), format!("[] {AGENT} http://172.16.0.1:3129 1"));
    // A cd inside a subshell or into a missing dir doesn't break the session.
    let r = call(&h, "b4", json!({"tool": "Bash", "command": "(cd /); cd deeper && pwd"})).await;
    assert!(text_of(&r).trim().ends_with("sub/deeper"));
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_exit_codes_and_truncation() {
    let (h, _c) = configured().await;
    let r = call(&h, "e1", json!({"tool": "Bash", "command": "echo oops; exit 3"})).await;
    assert!(r.is_error);
    assert!(text_of(&r).ends_with("Exit code 3"), "{}", text_of(&r));
    let r = call(&h, "e2", json!({"tool": "Bash", "command": "grep needle /dev/null"})).await;
    assert!(!r.is_error, "grep exit 1 is not an error");
    let r = call(&h, "e3", json!({"tool": "Bash", "command": "head -c 40000 /dev/zero | tr '\\0' x"})).await;
    let t = text_of(&r);
    assert!(t.starts_with("Output too large (40000 characters)"), "{}", &t[..100]);
    assert!(matches!(r.detail, HandsDetail::Bash { truncated: true, output_bytes: 40000, .. }));
    let r = call(&h, "e4", json!({"tool": "Bash", "command": "head -c 30000 /dev/zero | tr '\\0' y; exit 1"})).await;
    let t = text_of(&r);
    assert!(r.is_error && t.contains("characters truncated") && t.ends_with("Exit code 1"));
    assert!(t.chars().count() < 10_200);
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_timeout_moves_to_background_or_kills_sleep() {
    let (h, mut c) = configured().await;
    let r = call(&h, "t1", json!({"tool": "Bash", "command": "echo start; sleep 1; echo done", "timeout": 300})).await;
    assert!(!r.is_error);
    let t = text_of(&r);
    assert!(t.contains("moved to the background"), "{t}");
    let task_id = match &r.detail {
        HandsDetail::Bash { task_id: Some(id), .. } => id.clone(),
        d => panic!("{d:?}"),
    };
    let r = call(&h, "t2", json!({"tool": "TaskOutput", "task_id": task_id, "block": true, "timeout": 5000})).await;
    let t = text_of(&r);
    assert!(t.contains("exited with code 0") && t.contains("start") && t.contains("done"), "{t}");
    let ev = c.event(|f| matches!(&f.body, ControlBody::TaskExited { task, .. } if task.task_id == task_id)).await;
    assert!(matches!(ev.body, ControlBody::TaskExited { task: TaskInfo { status: TaskStatus::Exited, .. }, .. }));

    let r = call(&h, "t3", json!({"tool": "Bash", "command": "sleep 30", "timeout": 200})).await;
    assert!(r.is_error && text_of(&r).contains("timed out"), "{}", text_of(&r));
}

/// B2: a foreground call moved to the background is a task, and its output lives with the
/// tasks: the newest-64 pruning of later foreground calls' outputs must not delete it.
#[tokio::test(flavor = "multi_thread")]
async fn moved_task_output_survives_later_calls() {
    let (h, _c) = configured().await;
    let r = call(&h, "slow", json!({"tool": "Bash", "command": "echo start-marker; sleep 60", "timeout": 300})).await;
    let task_id = match &r.detail {
        HandsDetail::Bash { task_id: Some(id), .. } => id.clone(),
        d => panic!("{d:?}"),
    };
    for i in 0..=nest_guest::output::KEEP_CALL_OUTPUTS {
        call(&h, &format!("q{i}"), json!({"tool": "Bash", "command": "true"})).await;
    }
    let t = text_of(&call(&h, "to", json!({"tool": "TaskOutput", "task_id": task_id})).await);
    assert!(t.contains("start-marker"), "task output lost: {t}");
}

#[tokio::test(flavor = "multi_thread")]
async fn background_task_output_and_stop() {
    let (h, mut c) = configured().await;
    let r = call(
        &h,
        "bg1",
        json!({"tool": "Bash", "command": "while true; do echo tick; sleep 0.05; done", "run_in_background": true, "description": "ticker"}),
    )
    .await;
    let task_id = match &r.detail {
        HandsDetail::Bash { task_id: Some(id), .. } => id.clone(),
        d => panic!("{d:?}"),
    };
    assert!(task_id.starts_with("bg_"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = call(&h, "bg2", json!({"tool": "TaskOutput", "task_id": task_id})).await;
    assert!(text_of(&r).contains("ticker): running") && text_of(&r).contains("tick"), "{}", text_of(&r));
    let r = call(&h, "bg3", json!({"tool": "TaskStop", "task_id": task_id})).await;
    match &r.detail {
        HandsDetail::TaskStop { task } => assert_eq!(task.status, TaskStatus::Killed),
        d => panic!("{d:?}"),
    }
    c.event(|f| matches!(&f.body, ControlBody::TaskExited { task, .. } if task.status == TaskStatus::Killed)).await;
    let resps = call_raw(&h, &request("bg4", json!({"tool": "TaskOutput", "task_id": "bg_nope"}))).await;
    assert!(matches!(&resps[..], [HandsResponse::Error { error, .. }] if error.code == "unknown_task"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_kills_the_whole_tree() {
    let (h, _c) = configured().await;
    let pidfile = h.ws.join("child.pid");
    let req = request(
        "k1",
        json!({"tool": "Bash", "command": format!("sleep 60 & echo $! > {}; echo started; wait", pidfile.display())}),
    );
    let s = emulator::connect(&h.socket, PORT_HANDS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    write_json(&mut w, &req).await.unwrap();
    let mut r = FramedReader::new(r);
    let first: HandsResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert!(matches!(first, HandsResponse::Started { .. }));
    // Wait for the grandchild to exist.
    let mut pid = None;
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(&pidfile)
            && let Ok(p) = s.trim().parse::<i32>() {
                pid = Some(p);
                break;
            }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let pid = pid.expect("child pid");
    assert!(pid_alive(pid));
    write_json(&mut w, &HandsCancel::Cancel {}).await.unwrap();
    let last: HandsResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    match last {
        HandsResponse::Result { result, .. } => {
            assert!(result.is_error);
            assert!(matches!(result.detail, HandsDetail::Bash { interrupted: true, .. }));
            assert!(text_of(&result).contains("started"));
        }
        other => panic!("{other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!pid_alive(pid), "grandchild survived cancel");

    // Hangup also cancels.
    let pidfile2 = h.ws.join("child2.pid");
    let req = request("k2", json!({"tool": "Bash", "command": format!("sleep 60 & echo $! > {}; wait", pidfile2.display())}));
    let s = emulator::connect(&h.socket, PORT_HANDS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    write_json(&mut w, &req).await.unwrap();
    let mut r = FramedReader::new(r);
    let _started = r.next().await.unwrap().unwrap();
    let mut pid2 = None;
    for _ in 0..100 {
        if let Some(p) = std::fs::read_to_string(&pidfile2).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
            pid2 = Some(p);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drop(r);
    drop(w);
    let pid2 = pid2.unwrap();
    for _ in 0..50 {
        if !pid_alive(pid2) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!pid_alive(pid2), "grandchild survived hangup");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_write_edit_semantics() {
    let (h, _c) = configured().await;
    let f = h.ws.join("notes.txt");
    let fp = f.display().to_string();
    // Relative paths are rejected outright.
    let resps = call_raw(&h, &request("r0", json!({"tool": "Read", "file_path": "notes.txt"}))).await;
    assert!(matches!(&resps[..], [HandsResponse::Error { error, .. }] if error.code == "bad_request"));
    // Missing file.
    let r = call(&h, "r1", json!({"tool": "Read", "file_path": fp})).await;
    assert!(r.is_error && text_of(&r) == "File does not exist.");
    // Creating a new file needs no prior read; parents are created.
    let nested = h.ws.join("a/b/new.txt").display().to_string();
    let r = call(&h, "w0", json!({"tool": "Write", "file_path": nested, "content": "x\n"})).await;
    assert!(!r.is_error && matches!(r.detail, HandsDetail::Write { created: true, bytes: 2 }));
    // Overwriting an unread existing file is refused.
    std::fs::write(&f, "alpha\nbeta\ngamma\nbeta\n").unwrap();
    let r = call(&h, "w1", json!({"tool": "Write", "file_path": fp, "content": "nope"})).await;
    assert!(r.is_error && text_of(&r).contains("has not been read yet"));
    let r = call(&h, "e0", json!({"tool": "Edit", "file_path": fp, "old_string": "alpha", "new_string": "ALPHA"})).await;
    assert!(r.is_error && text_of(&r).contains("has not been read yet"));
    // Read: cat -n format.
    let r = call(&h, "r2", json!({"tool": "Read", "file_path": fp})).await;
    assert_eq!(text_of(&r), "     1\talpha\n     2\tbeta\n     3\tgamma\n     4\tbeta\n");
    assert!(matches!(r.detail, HandsDetail::Read { total_lines: 4, partial: false, .. }));
    // Ambiguous edit.
    let r = call(&h, "e1", json!({"tool": "Edit", "file_path": fp, "old_string": "beta", "new_string": "B"})).await;
    assert!(r.is_error && text_of(&r).starts_with("Found 2 matches"));
    let r = call(&h, "e2", json!({"tool": "Edit", "file_path": fp, "old_string": "zzz", "new_string": "B"})).await;
    assert!(r.is_error && text_of(&r).starts_with("String to replace not found"));
    let r = call(&h, "e3", json!({"tool": "Edit", "file_path": fp, "old_string": "gamma", "new_string": "GAMMA"})).await;
    assert!(!r.is_error && matches!(r.detail, HandsDetail::Edit { replacements: 1, changed_since_read: false }));
    assert!(text_of(&r).contains("     3\tGAMMA"));
    // External change: a unique match still applies, with the staleness note.
    std::fs::write(&f, "alpha\nbeta\nGAMMA\nbeta\nextra line\n").unwrap();
    let r = call(&h, "e4", json!({"tool": "Edit", "file_path": fp, "old_string": "extra", "new_string": "EXTRA"})).await;
    assert!(!r.is_error, "{}", text_of(&r));
    assert!(matches!(r.detail, HandsDetail::Edit { changed_since_read: true, .. }));
    assert!(text_of(&r).contains("had changed since you last read it"));
    let r = call(&h, "e5", json!({"tool": "Edit", "file_path": fp, "old_string": "beta", "new_string": "BETA", "replace_all": true})).await;
    assert!(matches!(r.detail, HandsDetail::Edit { replacements: 2, .. }));
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "alpha\nBETA\nGAMMA\nBETA\nEXTRA line\n");
    // Partial reads: offset/limit, and the default-limit notice.
    let big = h.ws.join("big.txt");
    std::fs::write(&big, (1..=2500).map(|i| format!("l{i}\n")).collect::<String>()).unwrap();
    let bp = big.display().to_string();
    let r = call(&h, "r3", json!({"tool": "Read", "file_path": bp, "offset": 2499, "limit": 5})).await;
    assert_eq!(text_of(&r), "  2499\tl2499\n  2500\tl2500\n");
    let r = call(&h, "r4", json!({"tool": "Read", "file_path": bp})).await;
    assert!(text_of(&r).contains("PARTIAL view: showing lines 1-2000 of 2500"));
    // A partial read doesn't count as read for Write.
    let r = call(&h, "w2", json!({"tool": "Write", "file_path": bp, "content": "x"})).await;
    assert!(r.is_error);
    let r = call(&h, "r5", json!({"tool": "Read", "file_path": bp, "offset": 9000})).await;
    assert!(text_of(&r).contains("only 2500 lines"));
    // Empty file and directory.
    std::fs::write(h.ws.join("empty"), "").unwrap();
    let r = call(&h, "r6", json!({"tool": "Read", "file_path": h.ws.join("empty").display().to_string()})).await;
    assert!(text_of(&r).contains("empty"));
    let r = call(&h, "r7", json!({"tool": "Read", "file_path": h.ws.display().to_string()})).await;
    assert!(r.is_error && text_of(&r).contains("directory"));
}

#[tokio::test(flavor = "multi_thread")]
async fn read_image() {
    let (h, _c) = configured().await;
    let png = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    )
    .unwrap();
    let p = h.ws.join("dot.png");
    std::fs::write(&p, &png).unwrap();
    let r = call(&h, "i1", json!({"tool": "Read", "file_path": p.display().to_string()})).await;
    match &r.content[..] {
        [ToolContent::Image { media_type, data_b64 }] => {
            assert_eq!(media_type, "image/png");
            assert!(data_b64.starts_with("iVBORw0KGgo"));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_and_grep() {
    let (h, _c) = configured().await;
    std::fs::create_dir_all(h.ws.join("src/inner")).unwrap();
    std::fs::write(h.ws.join("src/a.rs"), "fn main() {}\n// TODO one\n").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(h.ws.join("src/inner/b.rs"), "// todo two\n// TODO three\n").unwrap();
    std::fs::write(h.ws.join("README.md"), "TODO docs\n").unwrap();

    let r = call(&h, "g1", json!({"tool": "Glob", "pattern": "**/*.rs"})).await;
    let lines: Vec<String> = text_of(&r).lines().map(str::to_string).collect();
    assert_eq!(lines, vec![h.ws.join("src/inner/b.rs").display().to_string(), h.ws.join("src/a.rs").display().to_string()]);
    let r = call(&h, "g2", json!({"tool": "Glob", "pattern": "*.rs"})).await;
    assert_eq!(text_of(&r), "No files found");
    let r = call(&h, "g3", json!({"tool": "Glob", "pattern": "*.rs", "path": "src"})).await;
    assert_eq!(text_of(&r).trim(), h.ws.join("src/a.rs").display().to_string());

    let r = call(&h, "q1", json!({"tool": "Grep", "pattern": "TODO"})).await;
    assert_eq!(text_of(&r).lines().count(), 3, "{}", text_of(&r));
    let r = call(&h, "q2", json!({"tool": "Grep", "pattern": "todo", "-i": true, "output_mode": "count", "glob": "*.rs"})).await;
    let t = text_of(&r);
    assert!(t.contains("Total: 3"), "{t}");
    let r = call(&h, "q3", json!({"tool": "Grep", "pattern": "three", "output_mode": "content", "-n": true, "-B": 1})).await;
    let t = text_of(&r);
    assert!(t.contains(":2:// TODO three") && t.contains("-1-// todo two"), "{t}");
    let r = call(&h, "q4", json!({"tool": "Grep", "pattern": "TODO", "head_limit": 1, "offset": 1})).await;
    let t = text_of(&r);
    assert!(t.contains("Showing entries 2-2 of 3"), "{t}");
    let r = call(&h, "q5", json!({"tool": "Grep", "pattern": "absent-xyz"})).await;
    assert_eq!(text_of(&r), "No files found");
    let r = call(&h, "q6", json!({"tool": "Grep", "pattern": "(unclosed"})).await;
    assert!(r.is_error);
}

#[tokio::test(flavor = "multi_thread")]
async fn ingress_tcp_splice_and_reject() {
    let (h, _c) = configured().await;
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        loop {
            let n = s.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            s.write_all(&buf[..n]).await.unwrap();
        }
    });
    let mut s = emulator::connect(&h.socket, PORT_INGRESS).await.unwrap();
    // Header and the first raw bytes in one write: the remainder must reach the target.
    let mut first = nest_protocol::guest::frame::encode_json(&IngressRequest::Tcp { port }).unwrap();
    first.extend_from_slice(b"GET / HTTP/1.0\r\n\r\n");
    s.write_all(&first).await.unwrap();
    let mut r = FramedReader::new(s);
    let resp: IngressResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert_eq!(resp, IngressResponse::Accepted { connected: Some(format!("127.0.0.1:{port}")), pid: None });
    let (mut s, rest) = r.into_parts();
    let mut got = rest;
    while got.len() < 18 {
        let mut buf = [0u8; 64];
        let n = s.read(&mut buf).await.unwrap();
        got.extend_from_slice(&buf[..n]);
    }
    assert_eq!(&got, b"GET / HTTP/1.0\r\n\r\n");
    s.write_all(b"more").await.unwrap();
    let mut buf = [0u8; 4];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"more");

    // Nothing listening → rejected, retryable.
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    drop(dead);
    let mut s = emulator::connect(&h.socket, PORT_INGRESS).await.unwrap();
    write_json(&mut s, &IngressRequest::Tcp { port: dead_port }).await.unwrap();
    let mut r = FramedReader::new(s);
    let resp: IngressResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert!(matches!(resp, IngressResponse::Rejected { error } if error.code == "connect_refused" && error.retryable));
}

/// B3: like hands, an ingress PTY is `busy` (retryable) until `configure`.
#[tokio::test(flavor = "multi_thread")]
async fn pty_before_configure_is_busy() {
    let h = harness().await;
    let s = emulator::connect(&h.socket, PORT_INGRESS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    let req = IngressRequest::Pty { agent_id: None, cols: 80, rows: 24, command: Some(vec!["true".into()]), cwd: None, env: Default::default() };
    write_json(&mut w, &req).await.unwrap();
    let mut r = FramedReader::new(r);
    let f = tokio::time::timeout(Duration::from_secs(5), r.next()).await.unwrap().unwrap().unwrap();
    let resp: IngressResponse = parse_json(&f).unwrap();
    assert!(matches!(&resp, IngressResponse::Rejected { error } if error.code == "busy" && error.retryable), "{resp:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ingress_pty() {
    let (h, _c) = configured().await;
    let s = emulator::connect(&h.socket, PORT_INGRESS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    let req = IngressRequest::Pty {
        agent_id: Some(AgentId(AGENT.into())),
        cols: 80,
        rows: 24,
        command: Some(vec!["/bin/sh".into(), "-c".into(), "echo hello-pty $NEST_AGENT_ID; read x; echo got:$x; stty size".into()]),
        cwd: None,
        env: Default::default(),
    };
    write_json(&mut w, &req).await.unwrap();
    let mut r = FramedReader::new(r);
    let resp: IngressResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert!(matches!(resp, IngressResponse::Accepted { pid: Some(_), .. }));
    let mut out = String::new();
    let mut sent = false;
    let exit = loop {
        let f = tokio::time::timeout(Duration::from_secs(10), r.next()).await.unwrap().unwrap().unwrap();
        match f.kind {
            Kind::Data => {
                out.push_str(&String::from_utf8_lossy(&f.payload));
                if !sent && out.contains("hello-pty") {
                    write_json(&mut w, &PtyControl::Resize { cols: 100, rows: 30 }).await.unwrap();
                    write_data(&mut w, b"abc\n").await.unwrap();
                    sent = true;
                }
            }
            Kind::Json => break parse_json::<PtyControl>(&f).unwrap(),
        }
    };
    assert!(out.contains(&format!("hello-pty {AGENT}")), "{out}");
    assert!(out.contains("got:abc"), "{out}");
    assert!(out.contains("30 100"), "resize not applied: {out}");
    assert_eq!(exit, PtyControl::Exit { code: Some(0), signal: None });
}

/// The PTY's fds are close-on-exec: the session's own process holds its terminal on 0-2 only,
/// and no process the guest spawns (here the session's; in the failure, a concurrent Bash task)
/// inherits the master or the slave and keeps the terminal open after the shell exits.
#[tokio::test(flavor = "multi_thread")]
async fn pty_fds_are_not_inherited() {
    let (h, _c) = configured().await;
    let s = emulator::connect(&h.socket, PORT_INGRESS).await.unwrap();
    let (r, mut w) = tokio::io::split(s);
    let cmd = "for f in /proc/self/fd/*; do echo \"${f##*/} $(readlink $f)\"; done";
    let req = IngressRequest::Pty { agent_id: None, cols: 80, rows: 24, command: Some(vec!["/bin/sh".into(), "-c".into(), cmd.into()]), cwd: None, env: Default::default() };
    write_json(&mut w, &req).await.unwrap();
    let mut r = FramedReader::new(r);
    let mut out = String::new();
    loop {
        let f = tokio::time::timeout(Duration::from_secs(10), r.next()).await.unwrap().unwrap().unwrap();
        match f.kind {
            Kind::Data => out.push_str(&String::from_utf8_lossy(&f.payload)),
            Kind::Json if parse_json::<PtyControl>(&f).is_ok() => break,
            Kind::Json => {}
        }
    }
    for line in out.lines() {
        let (fd, target) = line.trim().split_once(' ').unwrap_or((line, ""));
        let terminal = target.contains("/dev/pts/") || target.contains("ptmx");
        assert!(!terminal || ["0", "1", "2"].contains(&fd), "fd {fd} -> {target} leaked into the session:\n{out}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn port_watcher_reports_new_listener() {
    let (_h, mut c) = configured().await;
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let ev = tokio::time::timeout(
        Duration::from_secs(5),
        c.event(|f| matches!(&f.body, ControlBody::Ports { listening, .. } if listening.iter().any(|p| p.port == port))),
    )
    .await
    .expect("ports event with the new listener");
    if let ControlBody::Ports { listening, .. } = ev.body {
        let p = listening.iter().find(|p| p.port == port).unwrap();
        assert_eq!(p.bind, "loopback");
        assert_eq!(p.proto, PortProto::Tcp);
        assert_eq!(p.pid, Some(std::process::id()));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cli_relay_and_whoami() {
    let (h, mut c) = configured().await;
    let cli = h.cli.clone();
    let client = tokio::spawn(async move {
        let mut s = UnixStream::connect(&cli).await.unwrap();
        let req = CliRequest {
            agent_id: Some(AgentId(AGENT.into())),
            command: CliCommand::Notify { to: "captain".into(), message: "green".into(), urgency: Urgency::High },
        };
        write_json(&mut s, &req).await.unwrap();
        let mut r = FramedReader::new(s);
        parse_json::<CliResponse>(&r.next().await.unwrap().unwrap()).unwrap()
    });
    let relayed = c.event(|f| matches!(f.body, ControlBody::Cli { .. })).await;
    match &relayed.body {
        ControlBody::Cli { agent_id, command: CliCommand::Notify { message, .. } } => {
            assert_eq!(agent_id.as_ref().unwrap().0, AGENT);
            assert_eq!(message, "green");
        }
        other => panic!("{other:?}"),
    }
    let reply = ControlFrame {
        id: None,
        reply_to: relayed.id,
        body: ControlBody::CliResult { result: CliResult::Ok { data: json!({"delivered": true}) } },
    };
    write_json(&mut c.w, &reply).await.unwrap();
    let resp = client.await.unwrap();
    assert_eq!(resp.result, CliResult::Ok { data: json!({"delivered": true}) });

    // whoami is answered locally.
    let mut s = UnixStream::connect(&h.cli).await.unwrap();
    write_json(&mut s, &CliRequest { agent_id: None, command: CliCommand::Whoami {} }).await.unwrap();
    let mut r = FramedReader::new(s);
    let resp: CliResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert_eq!(resp.result, CliResult::Ok { data: json!({"sandbox_id": "sbx_test", "agent_id": null, "epoch": EPOCH}) });
}

/// B4: after a memory restore the guest holds the parent's identity; nestd configures the fork
/// child at the child's own epoch (1) before `resume{fork}`. The fence is per sandbox id.
#[tokio::test(flavor = "multi_thread")]
async fn fork_child_configures_at_its_own_epoch() {
    let (h, mut c) = configured().await;
    let child = ControlBody::Configure { sandbox_id: SandboxId("sbx_child".into()), epoch: Epoch(1), hostname: "sbx-child".into(), agents: vec![slot(&h.ws)] };
    assert_eq!(c.request(child).await, ControlBody::Ok {});
    let mut req = request("c1", json!({"tool": "Bash", "command": "true"}));
    req.epoch = Epoch(1);
    assert!(matches!(call_raw(&h, &req).await.last(), Some(HandsResponse::Result { .. })), "hands refused at the child's epoch");
}

#[tokio::test(flavor = "multi_thread")]
async fn control_lifecycle_requests() {
    let (h, mut c) = configured().await;
    // Resume with a fork identity: unprivileged, so clock/hostname are skipped but identity is recorded.
    let body = c
        .request(ControlBody::Resume {
            wall_clock_ms: nest_guest::state::now_ms(),
            entropy_b64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 64]),
            fork: Some(ForkIdentity {
                new_sandbox_id: SandboxId("sbx_fork".into()),
                hostname: "sbx-fork".into(),
                machine_id: "0".repeat(32),
            }),
        })
        .await;
    assert!(matches!(body, ControlBody::ResumeDone { .. }));
    let mut s = UnixStream::connect(&h.cli).await.unwrap();
    write_json(&mut s, &CliRequest { agent_id: None, command: CliCommand::Whoami {} }).await.unwrap();
    let mut r = FramedReader::new(s);
    let resp: CliResponse = parse_json(&r.next().await.unwrap().unwrap()).unwrap();
    assert!(matches!(&resp.result, CliResult::Ok { data } if data["sandbox_id"] == "sbx_fork"));

    assert_eq!(c.request(ControlBody::PrepareSnapshot { drop_caches: true, fsfreeze: vec![] }).await, ControlBody::Ok {});
    assert_eq!(c.request(ControlBody::Thaw {}).await, ControlBody::Ok {});
    match c.request(ControlBody::Health {}).await {
        ControlBody::HealthReport { report } => {
            assert!(report.mem_total_kb > 0);
            assert_eq!(report.agents.len(), 1);
            assert_eq!(report.disks.len(), 1);
        }
        other => panic!("{other:?}"),
    }
    // Lowering the epoch (of the sandbox the guest now is) is refused; detaching removes the agent.
    let low = ControlBody::Configure {
        sandbox_id: SandboxId("sbx_fork".into()),
        epoch: Epoch(EPOCH - 1),
        hostname: "x".into(),
        agents: vec![],
    };
    assert!(matches!(c.request(low).await, ControlBody::Error { error } if error.code == "stale_epoch"));
    let body = c.request(ControlBody::AgentDetach { agent_id: AgentId(AGENT.into()), kill_processes: true }).await;
    assert_eq!(body, ControlBody::Ok {});
    let resps = call_raw(&h, &request("d1", json!({"tool": "Bash", "command": "true"}))).await;
    assert!(matches!(&resps[..], [HandsResponse::Error { error, .. }] if error.code == "unknown_agent"));
    // A host-only message type from the guest's perspective gets an error reply.
    let body = c.request(ControlBody::Ports { listening: vec![], ts_ms: 0 }).await;
    assert!(matches!(body, ControlBody::Error { error } if error.code == "bad_request"));
    let _ = h.tmp.path();
}

#[tokio::test(flavor = "multi_thread")]
async fn reconnect_buffers_task_events() {
    let (h, c) = configured().await;
    let r = call(&h, "x1", json!({"tool": "Bash", "command": "sleep 0.3", "run_in_background": true})).await;
    let task_id = match r.detail {
        HandsDetail::Bash { task_id: Some(id), .. } => id,
        d => panic!("{d:?}"),
    };
    drop(c); // control connection drops (e.g. snapshot restore)
    tokio::time::sleep(Duration::from_millis(800)).await;
    let (mut c, hello) = Control::open(&h).await;
    assert!(matches!(hello.body, ControlBody::Hello { .. }));
    c.configure(&h.ws).await;
    c.event(|f| matches!(&f.body, ControlBody::TaskExited { task, .. } if task.task_id == task_id)).await;
}

// --- regressions from the review ------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn read_refuses_fifos_and_survives_huge_limits() {
    let (h, _c) = configured().await;
    let fifo = h.ws.join("fifo");
    assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
    let r = tokio::time::timeout(Duration::from_secs(5), call(&h, "f1", json!({"tool": "Read", "file_path": fifo.display().to_string()})))
        .await
        .expect("Read on a FIFO must not block");
    assert!(r.is_error && text_of(&r).contains("not a regular file"), "{}", text_of(&r));
    // offset + u64::MAX limit used to overflow (`start + count - 1`).
    let f = h.ws.join("a.txt");
    std::fs::write(&f, "l1\nl2\nl3\n").unwrap();
    let r = call(&h, "f2", json!({"tool": "Read", "file_path": f.display().to_string(), "offset": 2, "limit": u64::MAX})).await;
    assert_eq!(text_of(&r), "     2\tl2\n     3\tl3\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn write_staleness_and_symlinks() {
    let (h, _c) = configured().await;
    // Write after a concurrent change is rejected; an mtime-only change (touch) is not.
    let s = h.ws.join("s.txt");
    let sp = s.display().to_string();
    std::fs::write(&s, "v1\n").unwrap();
    call(&h, "s1", json!({"tool": "Read", "file_path": sp})).await;
    std::fs::write(&s, "v2 - changed by someone else\n").unwrap();
    let r = call(&h, "s2", json!({"tool": "Write", "file_path": sp, "content": "v3\n"})).await;
    assert!(r.is_error && text_of(&r).contains("modified since read"), "{}", text_of(&r));
    assert_eq!(std::fs::read_to_string(&s).unwrap(), "v2 - changed by someone else\n");
    call(&h, "s3", json!({"tool": "Read", "file_path": sp})).await;
    std::thread::sleep(Duration::from_millis(20));
    assert!(std::process::Command::new("touch").arg(&s).status().unwrap().success());
    let r = call(&h, "s4", json!({"tool": "Write", "file_path": sp, "content": "v3\n"})).await;
    assert!(!r.is_error, "{}", text_of(&r));
    // Write and Edit go through symlinks and keep hard links.
    let target = h.ws.join("target.txt");
    std::fs::write(&target, "orig\n").unwrap();
    let link = h.ws.join("link.txt");
    std::os::unix::fs::symlink("target.txt", &link).unwrap();
    let lp = link.display().to_string();
    call(&h, "l1", json!({"tool": "Read", "file_path": lp})).await;
    let r = call(&h, "l2", json!({"tool": "Write", "file_path": lp, "content": "new\n"})).await;
    assert!(!r.is_error, "{}", text_of(&r));
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "new\n");
    let r = call(&h, "l3", json!({"tool": "Edit", "file_path": lp, "old_string": "new", "new_string": "edited"})).await;
    assert!(!r.is_error, "{}", text_of(&r));
    assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "edited\n");
    let hard = h.ws.join("hard.txt");
    std::fs::hard_link(&target, &hard).unwrap();
    call(&h, "l4", json!({"tool": "Read", "file_path": hard.display().to_string()})).await;
    call(&h, "l5", json!({"tool": "Write", "file_path": hard.display().to_string(), "content": "both\n"})).await;
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "both\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn bash_warns_when_cwd_is_gone() {
    let (h, _c) = configured().await;
    let gone = h.ws.join("gone");
    std::fs::create_dir_all(&gone).unwrap();
    call(&h, "c1", json!({"tool": "Bash", "command": format!("cd {}", gone.display())})).await;
    std::fs::remove_dir(&gone).unwrap();
    let r = call(&h, "c2", json!({"tool": "Bash", "command": "pwd"})).await;
    let t = text_of(&r);
    assert!(t.contains("does not exist; running in"), "{t}");
    assert!(t.contains(&h.ws.display().to_string()), "falls back to the slot cwd: {t}");
}

#[test]
fn prune_keeps_newest_outputs() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..10 {
        let p = dir.path().join(format!("c{i}.out"));
        std::fs::write(&p, vec![b'x'; 100]).unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + i);
        std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
    }
    let protect = dir.path().join("c0.out");
    nest_guest::output::prune_dir(dir.path(), 3, 10_000, &protect);
    let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    left.sort();
    assert_eq!(left, ["c0.out", "c7.out", "c8.out", "c9.out"]);
    nest_guest::output::prune_dir(dir.path(), 100, 250, &protect);
    let n = std::fs::read_dir(dir.path()).unwrap().count();
    assert_eq!(n, 3, "byte budget keeps the newest two plus the protected file");
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_env_sets_proxy_and_identity() {
    let (h, _c) = configured().await;
    let r = call(&h, "e1", json!({"tool": "Bash", "command": "echo $NEST_AGENT_ID $HTTPS_PROXY ${HOME:+home-set}"})).await;
    assert_eq!(text_of(&r).trim(), format!("{AGENT} http://172.16.0.1:3129 home-set"));
}
