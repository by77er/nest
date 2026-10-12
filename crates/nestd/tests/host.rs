#![allow(clippy::result_large_err)]
//! End-to-end nestd test: mock FleetDO (WebSocket), fake driver with an in-process fake guest
//! agent (behind the vsock emulator), fake agent runner and fake nest-proxy.
//!
//! Covers: hello/hello_ack, ordered command execution with exactly one `command_result` each,
//! dedup of redelivered commands, stale-epoch rejection, agent start with hands (guest slot +
//! runner `agent_start`), port events, commit CAS round-trip, and self-fencing (proxy drop,
//! runner fence, `fenced` state, salvage commit) when heartbeats stop being acknowledged.

use std::collections::BTreeMap;
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::*;
use nest_protocol::guest::frame::{self, Decoder};
use nest_protocol::guest::{CliCommand, CliResult, ControlBody, ControlFrame, ListeningPort, PortProto, TaskInfo, TaskStatus};
use nest_protocol::host::proxy::{ProxyCommand, ProxyEvent};
use nest_protocol::host::runner::{RunnerCommand, RunnerEvent};
use nest_protocol::host::{fdpass, PROTOCOL_VERSION as HOST_PROTOCOL_VERSION};
use nest_protocol::model::*;
use nestd::config::Config;
use nestd::driver::{Driver, Vm, VmSpec};
use nestd::enroll::Enrolled;
use nestd::host::Host;
use nestd::vsock::Emulator;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

// ---------------------------------------------------------------------------------------------
// Fake driver + guest
// ---------------------------------------------------------------------------------------------

type Seen = Arc<Mutex<Vec<ControlBody>>>;

struct FakeDriver {
    seen: Seen,
}

#[async_trait]
impl Driver for FakeDriver {
    fn name(&self) -> &'static str {
        "fake"
    }
    async fn create(&self, spec: VmSpec) -> std::io::Result<Box<dyn Vm>> {
        std::fs::create_dir_all(&spec.vm_dir)?;
        Ok(Box::new(FakeVm { spec, seen: self.seen.clone(), emu: None, guest: None }))
    }
}

struct FakeVm {
    spec: VmSpec,
    seen: Seen,
    emu: Option<Emulator>,
    guest: Option<tokio::task::JoinHandle<()>>,
}

#[async_trait]
impl Vm for FakeVm {
    fn vsock_uds_path(&self) -> PathBuf {
        self.spec.vm_dir.join("vsock.sock")
    }
    fn disk_path(&self) -> PathBuf {
        self.spec.disk_path.clone()
    }
    async fn start(&mut self) -> std::io::Result<()> {
        // A slow boot, to race commands and fences against it.
        if self.spec.sandbox.0.starts_with("sbx_slow") {
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        let gdir = self.spec.vm_dir.join("guest");
        std::fs::create_dir_all(&gdir)?;
        // Write something to the disk so commits have a non-empty chunk.
        std::fs::write(gdir.join("marker"), b"x")?;
        let mut f = std::fs::OpenOptions::new().write(true).open(&self.spec.disk_path)?;
        std::io::Write::write_all(&mut f, b"guest data")?;
        self.guest = Some(fake_guest(&gdir, self.seen.clone()));
        self.emu = Some(Emulator::start(&self.vsock_uds_path(), &gdir)?);
        Ok(())
    }
    async fn pause(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    async fn resume(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    async fn stop(&mut self) -> std::io::Result<()> {
        if let Some(g) = self.guest.take() {
            g.abort();
        }
        self.emu = None;
        Ok(())
    }
}

fn fake_guest(dir: &Path, seen: Seen) -> tokio::task::JoinHandle<()> {
    let _ = std::fs::remove_file(dir.join("1024.sock"));
    let listener = UnixListener::bind(dir.join("1024.sock")).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else { break };
            let hello = ControlFrame {
                id: None,
                reply_to: None,
                body: ControlBody::Hello { protocol_version: 1, agent_version: "fake".into(), boot_id: "b1".into(), instance_id: "i1".into(), since_boot_ms: 1, capabilities: vec![] },
            };
            s.write_all(&frame::encode_json(&hello).unwrap()).await.unwrap();
            let mut dec = Decoder::new();
            let mut buf = vec![0u8; 65536];
            'conn: loop {
                let n = match s.read(&mut buf).await {
                    Ok(0) | Err(_) => break 'conn,
                    Ok(n) => n,
                };
                dec.push(&buf[..n]);
                while let Ok(Some(f)) = dec.next_frame() {
                    let cf: ControlFrame = serde_json::from_slice(&f.payload).unwrap();
                    seen.lock().unwrap().push(cf.body.clone());
                    let ok = ControlFrame { id: None, reply_to: cf.id, body: ControlBody::Ok {} };
                    if s.write_all(&frame::encode_json(&ok).unwrap()).await.is_err() {
                        break 'conn;
                    }
                    if let ControlBody::Configure { .. } = cf.body {
                        let ports = ControlFrame {
                            id: None,
                            reply_to: None,
                            body: ControlBody::Ports { listening: vec![ListeningPort { port: 5173, proto: PortProto::Tcp, bind: "loopback".into(), pid: None, process: None }], ts_ms: 1 },
                        };
                        let _ = s.write_all(&frame::encode_json(&ports).unwrap()).await;
                        // A program in the sandbox runs `nest ask`, and a background task exits.
                        let cli = ControlFrame {
                            id: Some(900),
                            reply_to: None,
                            body: ControlBody::Cli {
                                agent_id: Some(AgentId("agt_w".into())),
                                command: CliCommand::Ask { question: "ship?".into(), options: vec![], wait_s: 5 },
                            },
                        };
                        let _ = s.write_all(&frame::encode_json(&cli).unwrap()).await;
                        let task = ControlFrame {
                            id: None,
                            reply_to: None,
                            body: ControlBody::TaskExited {
                                agent_id: AgentId("agt_w".into()),
                                task: TaskInfo {
                                    task_id: "bg_1".into(),
                                    description: None,
                                    status: TaskStatus::Exited,
                                    exit_code: Some(0),
                                    output_path: "/tmp/bg_1".into(),
                                    output_bytes: 0,
                                    started_ms: 1,
                                    ended_ms: Some(2),
                                },
                            },
                        };
                        let _ = s.write_all(&frame::encode_json(&task).unwrap()).await;
                    }
                }
            }
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Mock FleetDO
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct FleetLog {
    events: Vec<HostEvent>,
    hellos: Vec<HostHello>,
    acks: Vec<u64>,
    claims: Vec<Vec<LeaseClaim>>,
    ca_renews: Vec<String>,
}

struct MockFleet {
    url: String,
    log: Arc<Mutex<FleetLog>>,
    commands: mpsc::UnboundedSender<Vec<Command>>,
    partition: Arc<AtomicBool>,
    /// Fail the next events batch with a retryable error (no ack), like FleetDO's handler error.
    fail_next_events: Arc<AtomicBool>,
}

const LEASE: LeaseTiming = LeaseTiming { heartbeat_ms: 50, host_fence_ms: 500, cp_expiry_ms: 800 };

/// Mock FleetDO. Accepts reconnects. While `partition` is set it answers nothing on the open
/// connection and refuses new ones (a network partition); clearing it lets the host reconnect.
async fn mock_fleet() -> MockFleet {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/fleet", l.local_addr().unwrap());
    let log = Arc::new(Mutex::new(FleetLog::default()));
    let partition = Arc::new(AtomicBool::new(false));
    let fail_next_events = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<Command>>();
    let (log2, part, fail) = (log.clone(), partition.clone(), fail_next_events.clone());
    tokio::spawn(async move {
        let mut seq = 0u64;
        let mut last_event_seq: Option<u64> = None;
        loop {
            let Ok((tcp, _)) = l.accept().await else { break };
            if part.load(Ordering::SeqCst) {
                drop(tcp);
                continue;
            }
            let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                assert_eq!(req.headers().get("authorization").unwrap(), "Bearer tok");
                Ok(resp)
            })
            .await
            else {
                continue;
            };
            let send = |m: FleetToHost| Message::Text(serde_json::to_string(&m).unwrap().into());
            loop {
                tokio::select! {
                    cmds = rx.recv() => {
                        let Some(cmds) = cmds else { return };
                        seq += 1;
                        if ws.send(send(FleetToHost::Commands { seq: Seq(seq), commands: cmds })).await.is_err() { break; }
                    }
                    msg = ws.next() => {
                        let Some(Ok(Message::Text(t))) = msg else { break };
                        if part.load(Ordering::SeqCst) {
                            continue; // partitioned: nothing gets through
                        }
                        let m: HostToFleet = serde_json::from_str(&t).unwrap();
                        match m {
                            HostToFleet::Hello(h) => {
                                log2.lock().unwrap().hellos.push(*h);
                                let ack = HelloAck { protocol_version: 1, server_ms: 0, last_event_seq: last_event_seq.map(Seq), lease: LEASE, host_token_expires_ms: 0 };
                                if ws.send(send(FleetToHost::HelloAck(ack))).await.is_err() { break; }
                            }
                            HostToFleet::Heartbeat { sent_ms, leases } => {
                                log2.lock().unwrap().claims.push(leases);
                                let _ = ws.send(send(FleetToHost::HeartbeatAck { sent_ms, server_ms: 0, revoked: vec![] })).await;
                            }
                            HostToFleet::Events { seq: es, events } => {
                                if fail.swap(false, Ordering::SeqCst) {
                                    let err = ErrorBody { code: "internal".into(), message: "handler failed".into(), retryable: true };
                                    let _ = ws.send(send(FleetToHost::Error { error: err })).await;
                                    continue;
                                }
                                if last_event_seq.is_some_and(|l| es.0 <= l) {
                                    let _ = ws.send(send(FleetToHost::Ack { up_to: es })).await;
                                    continue;
                                }
                                last_event_seq = Some(es.0);
                                // Answer commit requests (CAS): committed, or orphaned for salvage.
                                let mut answers = vec![];
                                for e in &events {
                                    if let HostEventBody::CommitRequest { request, sandbox, epoch, parent, kind, disk_manifest, mem_manifest, reason } = &e.body {
                                        let generation = GenerationRecord {
                                            id: GenerationId(format!("gen_{}", request.0)), sandbox: sandbox.clone(), parent: parent.clone(), epoch: *epoch,
                                            kind: *kind, disk_manifest: disk_manifest.clone(), mem_manifest: mem_manifest.clone(), reason: *reason, created_ms: 0,
                                        };
                                        let outcome = if *reason == CommitReason::Salvage { CommitOutcome::Orphaned { generation } } else { CommitOutcome::Committed { generation } };
                                        answers.push(Command { cmd: CommandId(format!("cmd_cr_{}", request.0)), issued_ms: 0, body: CommandBody::CommitResult { request: request.clone(), sandbox: sandbox.clone(), outcome } });
                                    }
                                }
                                log2.lock().unwrap().events.extend(events);
                                let _ = ws.send(send(FleetToHost::Ack { up_to: es })).await;
                                if !answers.is_empty() {
                                    seq += 1;
                                    let _ = ws.send(send(FleetToHost::Commands { seq: Seq(seq), commands: answers })).await;
                                }
                            }
                            HostToFleet::Ack { up_to } => log2.lock().unwrap().acks.push(up_to.0),
                            HostToFleet::CaRenew { csr_pem } => {
                                log2.lock().unwrap().ca_renews.push(csr_pem);
                                let ca = CaCertificate { cert_pem: "RENEWED".into(), chain_pem: "CHAIN".into(), expires_ms: i64::MAX / 2 };
                                let _ = ws.send(send(FleetToHost::ProxyCa(ca))).await;
                            }
                        }
                    }
                }
            }
        }
    });
    MockFleet { url, log, commands: tx, partition, fail_next_events }
}

impl MockFleet {
    /// Wait until `pred` matches some logged event; returns it.
    async fn wait_event(&self, what: &str, pred: impl Fn(&HostEventBody) -> bool) -> HostEventBody {
        for _ in 0..1500 {
            if let Some(e) = self.log.lock().unwrap().events.iter().find(|e| pred(&e.body)) {
                return e.body.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}; events: {:#?}", self.log.lock().unwrap().events);
    }

    fn results_for(&self, cmd: &str) -> Vec<CommandOutcome> {
        self.log
            .lock()
            .unwrap()
            .events
            .iter()
            .filter_map(|e| match &e.body {
                HostEventBody::CommandResult { cmd: c, outcome } if c.0 == cmd => Some(outcome.clone()),
                _ => None,
            })
            .collect()
    }

    async fn result(&self, cmd: &str) -> CommandOutcome {
        let cmd = cmd.to_string();
        match self.wait_event(&format!("result of {cmd}"), |b| matches!(b, HostEventBody::CommandResult { cmd: c, .. } if c.0 == cmd)).await {
            HostEventBody::CommandResult { outcome, .. } => outcome,
            _ => unreachable!(),
        }
    }
}

fn cmd(id: &str, body: CommandBody) -> Command {
    Command { cmd: CommandId(id.into()), issued_ms: 0, body }
}

fn policy() -> EgressPolicy {
    EgressPolicy {
        version: 1,
        allow: vec![AllowRule { host: HostPattern("github.com".into()), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None }],
        passthrough: vec![],
        inject: vec![],
        tcp: vec![],
        limits: EgressLimits { max_connections: 16, bandwidth_mbps: 10, max_inspected_body_bytes: 1 << 20 },
    }
}

// ---------------------------------------------------------------------------------------------
// Fake runner and proxy
// ---------------------------------------------------------------------------------------------

async fn fake_runner(path: &Path) -> Arc<Mutex<Vec<RunnerCommand>>> {
    let got = Arc::new(Mutex::new(vec![]));
    let s = loop {
        match UnixStream::connect(path).await {
            Ok(s) => break s,
            Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    };
    let mut f = Framed::new(s, LengthDelimitedCodec::new());
    let hello = RunnerEvent::Hello { protocol_version: HOST_PROTOCOL_VERSION, runner_version: "fake".into(), pid: 1 };
    f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
    let got2 = got.clone();
    tokio::spawn(async move {
        while let Some(Ok(b)) = f.next().await {
            got2.lock().unwrap().push(serde_json::from_slice(&b).unwrap());
        }
    });
    got
}

fn fake_proxy(path: PathBuf) -> Arc<Mutex<Vec<ProxyCommand>>> {
    use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
    let got = Arc::new(Mutex::new(vec![]));
    let got2 = got.clone();
    std::thread::spawn(move || {
        let fd: OwnedFd = loop {
            let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None).unwrap();
            if connect(fd.as_raw_fd(), &UnixAddr::new(&path).unwrap()).is_ok() {
                break fd;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        fdpass::send(fd.as_fd(), &ProxyEvent::Hello { protocol_version: HOST_PROTOCOL_VERSION, proxy_version: "fake".into(), pid: 1 }, &[]).unwrap();
        let mut buf = vec![];
        while let Ok(Some((c, _fds))) = fdpass::recv::<ProxyCommand>(fd.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY) {
            if let ProxyCommand::ResyncComplete { sandboxes, listeners } = &c {
                let _ = fdpass::send(fd.as_fd(), &ProxyEvent::ResyncAck { sandboxes: *sandboxes, listeners: *listeners }, &[]);
            }
            got2.lock().unwrap().push(c);
        }
    });
    got
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn host_lifecycle_commit_and_self_fence() {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "role": "burst",
        "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"),
        "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"},
        "flush_interval_ms": 20,
        "commit_timeout_ms": 5000,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None };
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let run_dir = dir.path().join("run");
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: seen.clone() }))).await.unwrap();
    let runner = fake_runner(&run_dir.join("runner.sock")).await;
    let proxy = fake_proxy(run_dir.join("proxy.sock"));

    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let hello = fleet.log.lock().unwrap().hellos[0].clone();
    assert_eq!(hello.host.0, "hst_t");
    assert!(hello.sandboxes.is_empty());

    // 1. Create a sandbox.
    let sbx = SandboxId("sbx_1".into());
    fleet
        .commands
        .send(vec![cmd(
            "cmd_create",
            CommandBody::SandboxCreate {
                sandbox: sbx.clone(),
                workstream: WorkstreamId("ws_1".into()),
                epoch: Epoch(1),
                image: "base".into(),
                resources: Resources { vcpus: 1, memory_mib: 512, disk_gib: 1 },
                policy: policy(),
                from: None,
            },
        )])
        .unwrap();
    assert!(matches!(fleet.result("cmd_create").await, CommandOutcome::Ok { .. }));
    fleet.wait_event("running", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Running, .. })).await;
    wait_until("ack of batch 1", || fleet.log.lock().unwrap().acks.contains(&1)).await;
    assert!(seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::Configure { epoch: Epoch(1), .. })));
    wait_until("proxy upsert", || proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxUpsert { .. }))).await;
    fleet.wait_event("port opened", |b| matches!(b, HostEventBody::Workstream { event } if matches!(event.kind, WorkstreamEventKind::PortOpened { port: 5173 }))).await;

    // 2. Start a worker with hands bound to the sandbox.
    let start = AgentStart {
        agent: AgentId("agt_w".into()),
        role: AgentRole::Worker,
        workstream: WorkstreamId("ws_1".into()),
        resume: None,
        hands: Some(HandsBinding { sandbox: sbx.clone(), epoch: Epoch(1), cwd: Some("/workspace/app".into()) }),
        launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: "w".into() } },
        oauth_token: "oauth".into(),
        session_ws_url: "ws://x".into(),
    };
    fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(start))]).unwrap();
    assert!(matches!(fleet.result("cmd_agent").await, CommandOutcome::Ok { .. }));
    wait_until("runner agent_start", || {
        runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(s) if s.hands.as_ref().is_some_and(|h| h.vsock_uds_path.ends_with("vsock.sock"))))
    })
    .await;
    assert!(seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::AgentAttach { slot } if slot.proxy_port == 3128 && slot.cwd == "/workspace/app")));

    // 2b. Guest CLI relay: `nest ask` → guest_cli event → guest_cli_result command → cli_result to the guest.
    let request = match fleet.wait_event("guest cli", |b| matches!(b, HostEventBody::GuestCli { .. })).await {
        HostEventBody::GuestCli { request, agent, command: CliCommand::Ask { question, .. }, .. } => {
            assert_eq!((agent.as_ref().map(|a| a.0.as_str()), question.as_str()), (Some("agt_w"), "ship?"));
            request
        }
        other => panic!("guest cli: {other:?}"),
    };
    fleet.commands.send(vec![cmd("cmd_cli", CommandBody::GuestCliResult { request, result: CliResult::Answered { answer: "yes".into() } })]).unwrap();
    wait_until("cli result relayed to the guest", || {
        seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::CliResult { result: CliResult::Answered { answer } } if answer == "yes"))
    })
    .await;
    fleet.wait_event("task exited", |b| matches!(b, HostEventBody::TaskExited { task, .. } if task.task_id == "bg_1")).await;

    // 3. Checkpoint: commit request → CAS → committed.
    fleet.commands.send(vec![cmd("cmd_ckpt", CommandBody::SandboxCheckpoint { sandbox: sbx.clone(), epoch: Epoch(1), reason: CommitReason::Checkpoint })]).unwrap();
    match fleet.result("cmd_ckpt").await {
        CommandOutcome::Ok { detail: Some(d) } => assert!(d["generation"].as_str().unwrap().starts_with("gen_req_")),
        other => panic!("checkpoint: {other:?}"),
    }

    // 4. Stale epoch is rejected; redelivered commands get the stored result (no re-execution).
    fleet.commands.send(vec![cmd("cmd_stale", CommandBody::SandboxSuspend { sandbox: sbx.clone(), epoch: Epoch(9), mode: SuspendMode::DiskOnly })]).unwrap();
    match fleet.result("cmd_stale").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("stale: {other:?}"),
    }
    let commits_before = fleet.log.lock().unwrap().events.iter().filter(|e| matches!(e.body, HostEventBody::CommitRequest { .. })).count();
    fleet.commands.send(vec![cmd("cmd_ckpt", CommandBody::SandboxCheckpoint { sandbox: sbx.clone(), epoch: Epoch(1), reason: CommitReason::Checkpoint })]).unwrap();
    wait_until("duplicate result", || fleet.results_for("cmd_ckpt").len() == 2).await;
    let commits_after = fleet.log.lock().unwrap().events.iter().filter(|e| matches!(e.body, HostEventBody::CommitRequest { .. })).count();
    assert_eq!(commits_before, commits_after, "redelivered command must not re-execute");

    // 5. Partition: the host self-fences ~500 ms after the last acknowledged heartbeat (locally:
    // proxy drop + runner fence), then reports it all once the partition heals.
    let t0 = std::time::Instant::now();
    fleet.partition.store(true, Ordering::SeqCst);
    wait_until("proxy drop", || proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxDrop { .. }))).await;
    let elapsed = t0.elapsed();
    assert!(elapsed >= Duration::from_millis(350) && elapsed < Duration::from_secs(3), "fence after {elapsed:?}");
    wait_until("runner fence", || runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::Fence { .. }))).await;
    // One runner fence for the whole host (no per-sandbox duplicate).
    tokio::time::sleep(Duration::from_millis(200)).await;
    let fences = runner.lock().unwrap().iter().filter(|c| matches!(c, RunnerCommand::Fence { .. })).count();
    assert_eq!(fences, 1, "self-fence must fence the runner once");
    fleet.partition.store(false, Ordering::SeqCst);
    fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    // The sandbox was dirty again after the checkpoint (it resumed running): salvage is offered.
    fleet.wait_event("salvage", |b| matches!(b, HostEventBody::CommitRequest { reason: CommitReason::Salvage, .. })).await;

    // Every command got exactly one result per delivery.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for e in fleet.log.lock().unwrap().events.iter() {
        if let HostEventBody::CommandResult { cmd, .. } = &e.body {
            *counts.entry(cmd.0.clone()).or_default() += 1;
        }
    }
    assert_eq!(counts.get("cmd_create"), Some(&1));
    assert_eq!(counts.get("cmd_agent"), Some(&1));
    assert_eq!(counts.get("cmd_ckpt"), Some(&2));
}

// ---------------------------------------------------------------------------------------------
// Network steering under a user namespace: real netns + tap0 + nft + listener handoff.
// ---------------------------------------------------------------------------------------------

struct NetnsCapture(Arc<Mutex<Option<Arc<nestd::net::Netns>>>>);

#[async_trait]
impl Driver for NetnsCapture {
    fn name(&self) -> &'static str {
        "fake-netns"
    }
    async fn create(&self, spec: VmSpec) -> std::io::Result<Box<dyn Vm>> {
        *self.0.lock().unwrap() = spec.netns.clone();
        std::fs::create_dir_all(&spec.vm_dir)?;
        Ok(Box::new(FakeVm { spec, seen: Arc::new(Mutex::new(vec![])), emu: None, guest: None }))
    }
}

type Received = Arc<Mutex<Vec<(nest_protocol::host::proxy::ListenerSpec, OwnedFd)>>>;

fn fake_proxy_keeping_fds(path: PathBuf) -> Received {
    use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
    let got: Received = Arc::new(Mutex::new(vec![]));
    let got2 = got.clone();
    std::thread::spawn(move || {
        let fd: OwnedFd = loop {
            let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None).unwrap();
            if connect(fd.as_raw_fd(), &UnixAddr::new(&path).unwrap()).is_ok() {
                break fd;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        fdpass::send(fd.as_fd(), &ProxyEvent::Hello { protocol_version: HOST_PROTOCOL_VERSION, proxy_version: "fake".into(), pid: 1 }, &[]).unwrap();
        let mut buf = vec![];
        while let Ok(Some((c, fds))) = fdpass::recv::<ProxyCommand>(fd.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY) {
            assert_eq!(fds.len(), c.expected_fds(), "fd count must match listeners");
            if let ProxyCommand::ListenersAdd { listeners, .. } = c {
                got2.lock().unwrap().extend(listeners.into_iter().zip(fds));
            } else if let ProxyCommand::ResyncComplete { sandboxes, listeners } = c {
                let _ = fdpass::send(fd.as_fd(), &ProxyEvent::ResyncAck { sandboxes, listeners }, &[]);
            }
        }
    });
    got
}

#[test]
fn netns_listeners_handed_to_proxy() {
    if !nestd::net::reexec_in_userns("netns_listeners_handed_to_proxy") {
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
        use nest_protocol::host::proxy::ListenerPurpose;
        use std::io::{Read, Write};
        let dir = tempfile::tempdir().unwrap();
        let fleet = mock_fleet().await;
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "role": "burst", "cell": "c",
            "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
            "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
            "driver": {"type": "process", "guest_command": ["unused"]},
            "network": {"type": "netns"},
            "flush_interval_ms": 20,
        }))
        .unwrap();
        let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None };
        let ns_slot = Arc::new(Mutex::new(None));
        let _host = Host::start(cfg, enrolled, Some(Arc::new(NetnsCapture(ns_slot.clone())))).await.unwrap();
        let received = fake_proxy_keeping_fds(dir.path().join("run/proxy.sock"));
        wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
        // The fake VM has no guest agent: creation will time out waiting for it, but the network
        // (netns, nft, listeners, proxy handoff) is set up before the VM boots.
        fleet
            .commands
            .send(vec![cmd(
                "cmd_create",
                CommandBody::SandboxCreate {
                    sandbox: SandboxId("sbx_n".into()),
                    workstream: WorkstreamId("ws".into()),
                    epoch: Epoch(1),
                    image: "base".into(),
                    resources: Resources { vcpus: 1, memory_mib: 256, disk_gib: 1 },
                    policy: EgressPolicy { tcp: vec![TcpException { host: "db.example.com".into(), port: 5432 }], ..policy() },
                    from: None,
                },
            )])
            .unwrap();
        for _ in 0..400 {
            if received.lock().unwrap().len() == 5 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let n = received.lock().unwrap().len();
        assert_eq!(n, 5, "listeners received; fleet events: {:#?}", fleet.log.lock().unwrap().events);
        let ns = ns_slot.lock().unwrap().clone().expect("netns captured");
        let (https, tcp_exc) = {
            let mut r = received.lock().unwrap();
            let purposes: Vec<String> = r.iter().map(|(s, _)| format!("{:?}@{}", s.purpose, s.addr)).collect();
            assert!(purposes.iter().any(|p| p.starts_with("Dns@172.16.0.1:53")), "{purposes:?}");
            let i = r.iter().position(|(s, _)| s.purpose == ListenerPurpose::HttpsTransparent).unwrap();
            let (_, https) = r.remove(i);
            let j = r.iter().position(|(s, _)| matches!(&s.purpose, ListenerPurpose::TcpException { rule } if rule == "db.example.com:5432")).unwrap();
            let (spec, tcp_exc) = r.remove(j);
            assert_eq!(spec.addr, "172.16.0.1:20000");
            (std::net::TcpListener::from(https), tcp_exc)
        };
        drop(tcp_exc);
        // The proxy's copy of the listener accepts connections made inside the sandbox netns.
        let acceptor = std::thread::spawn(move || {
            let (mut s, _) = https.accept().unwrap();
            let mut b = [0u8; 2];
            s.read_exact(&mut b).unwrap();
            s.write_all(b"ok").unwrap();
        });
        ns.run(|| {
            let mut c = std::net::TcpStream::connect("172.16.0.1:443")?;
            c.write_all(b"hi")?;
            let mut b = [0u8; 2];
            c.read_exact(&mut b)?;
            assert_eq!(&b, b"ok");
            Ok(())
        })
        .unwrap();
        acceptor.join().unwrap();
    });
}

// ---------------------------------------------------------------------------------------------
// Fencing races (review findings #3 and #8)
// ---------------------------------------------------------------------------------------------

struct Started {
    _host: Host,
    _dir: tempfile::TempDir,
    fleet: MockFleet,
    _runner: Arc<Mutex<Vec<RunnerCommand>>>,
    proxy: Arc<Mutex<Vec<ProxyCommand>>>,
}

async fn start_host() -> Started {
    start_host_with(None).await
}

async fn start_host_with(proxy_ca: Option<(CaCertificate, nest_protocol::host::Secret)>) -> Started {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "role": "burst", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": 5000,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca };
    let host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])) }))).await.unwrap();
    let runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    Started { _host: host, _dir: dir, fleet, _runner: runner, proxy }
}

fn create(id: &str, sandbox: &str) -> Command {
    cmd(
        id,
        CommandBody::SandboxCreate {
            sandbox: SandboxId(sandbox.into()),
            workstream: WorkstreamId("ws_1".into()),
            epoch: Epoch(1),
            image: "base".into(),
            resources: Resources { vcpus: 1, memory_mib: 512, disk_gib: 1 },
            policy: policy(),
            from: None,
        },
    )
}

/// Review #3: the lease lapses while `sandbox_create` is still booting. `Fenced` is terminal: the
/// create must not flip the sandbox back to `running`, must not report success, must not re-add
/// it to the proxy, and heartbeats must stop claiming it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fence_during_create_is_terminal() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_create", "sbx_slow")]).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.fleet.partition.store(true, Ordering::SeqCst); // lease lapses ~500 ms later, mid-boot
    wait_until("proxy drop", || h.proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxDrop { .. }))).await;
    tokio::time::sleep(Duration::from_millis(1600)).await; // let the boot finish
    h.fleet.partition.store(false, Ordering::SeqCst);
    match h.fleet.result("cmd_create").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("create after fence must fail: {other:?}"),
    }
    let states: Vec<SandboxState> = h
        .fleet
        .log
        .lock()
        .unwrap()
        .events
        .iter()
        .filter_map(|e| match &e.body {
            HostEventBody::SandboxState { state, .. } => Some(*state),
            _ => None,
        })
        .collect();
    let fenced_at = states.iter().position(|s| *s == SandboxState::Fenced).expect("fenced reported");
    assert!(!states[fenced_at..].contains(&SandboxState::Running), "state left fenced: {states:?}");
    // Nothing re-adds the sandbox to the proxy after the drop.
    let cmds = h.proxy.lock().unwrap().clone();
    let drop_at = cmds.iter().position(|c| matches!(c, ProxyCommand::SandboxDrop { .. })).unwrap();
    assert!(
        !cmds[drop_at..].iter().any(|c| matches!(c, ProxyCommand::SandboxUpsert { .. } | ProxyCommand::ListenersAdd { .. })),
        "proxy re-armed after fence: {cmds:?}"
    );
    // Heartbeats after the partition healed claim nothing.
    let n = h.fleet.log.lock().unwrap().claims.len();
    wait_until("fresh heartbeat", || h.fleet.log.lock().unwrap().claims.len() > n).await;
    let last = h.fleet.log.lock().unwrap().claims.last().cloned().unwrap();
    assert!(last.is_empty(), "fenced sandbox still claimed: {last:?}");
}

/// Review #8: a `fence` command takes effect on arrival, not behind a slow command in the
/// in-order executor (results are still reported in order).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fence_applies_on_arrival_behind_slow_commands() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    h.fleet.commands.send(vec![create("cmd_slow", "sbx_slow2")]).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let t0 = std::time::Instant::now();
    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_a".into())], reason: "test".into() })]).unwrap();
    wait_until("fence of sbx_a", || {
        h.proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxDrop { sandbox, .. } if sandbox.0 == "sbx_a"))
    })
    .await;
    assert!(t0.elapsed() < Duration::from_millis(800), "fence waited behind the slow create: {:?}", t0.elapsed());
    // Results still arrive in order: the slow create first, then the fence.
    assert!(matches!(h.fleet.result("cmd_fence").await, CommandOutcome::Ok { .. }));
    let order: Vec<String> = h
        .fleet
        .log
        .lock()
        .unwrap()
        .events
        .iter()
        .filter_map(|e| match &e.body {
            HostEventBody::CommandResult { cmd, .. } => Some(cmd.0.clone()),
            _ => None,
        })
        .collect();
    let slow = order.iter().position(|c| c == "cmd_slow").unwrap();
    let fence = order.iter().position(|c| c == "cmd_fence").unwrap();
    assert!(slow < fence, "{order:?}");
}

/// Review #7: FleetDO fails a batch (retryable error, no ack). The host must reconnect and resend
/// it, so it is never skipped by a later cumulative ack.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retryable_fleet_error_resends_the_failed_batch() {
    let h = start_host().await;
    h.fleet.fail_next_events.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    // The batch carrying cmd_a's events failed once; it still arrives, exactly once.
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    wait_until("reconnect", || h.fleet.log.lock().unwrap().hellos.len() >= 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let n = h.fleet.log.lock().unwrap().events.iter().filter(|e| matches!(&e.body, HostEventBody::CommandResult { cmd, .. } if cmd.0 == "cmd_a")).count();
    assert_eq!(n, 1);
}

/// Review #10: the proxy intermediate CA is renewed (new key + CSR) before it expires, and the
/// renewed certificate is installed in nest-proxy with the new key.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn proxy_ca_is_renewed_before_expiry() {
    let soon = nestd_now_ms() + 3600 * 1000; // expires in an hour: inside the renewal window
    let ca = CaCertificate { cert_pem: "ORIGINAL".into(), chain_pem: "CHAIN".into(), expires_ms: soon };
    let h = start_host_with(Some((ca, nest_protocol::host::Secret("OLD KEY".into())))).await;
    wait_until("ca_renew", || !h.fleet.log.lock().unwrap().ca_renews.is_empty()).await;
    assert!(h.fleet.log.lock().unwrap().ca_renews[0].contains("BEGIN CERTIFICATE REQUEST"));
    wait_until("renewed CA installed", || {
        h.proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::CaInstall { ca, key_pem } if ca.cert_pem == "RENEWED" && key_pem.0.contains("PRIVATE KEY")))
    })
    .await;
}

/// Review #17: a newer-epoch create of a sandbox that still has uncommitted work here salvages
/// that work (sibling branch) before the new incarnation reuses the disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn newer_epoch_create_salvages_old_work_first() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_1", "sbx_m")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_1").await, CommandOutcome::Ok { .. }));
    let mut c2 = create("cmd_2", "sbx_m");
    if let CommandBody::SandboxCreate { epoch, .. } = &mut c2.body {
        *epoch = Epoch(2);
    }
    h.fleet.commands.send(vec![c2]).unwrap();
    assert!(matches!(h.fleet.result("cmd_2").await, CommandOutcome::Ok { .. }));
    let events = h.fleet.log.lock().unwrap().events.clone();
    let salvage = events
        .iter()
        .position(|e| matches!(&e.body, HostEventBody::CommitRequest { reason: CommitReason::Salvage, epoch: Epoch(1), .. }))
        .expect("old epoch's work salvaged");
    let running2 = events
        .iter()
        .position(|e| matches!(&e.body, HostEventBody::SandboxState { state: SandboxState::Running, epoch: Epoch(2), .. }))
        .unwrap();
    assert!(salvage < running2);
}

fn nestd_now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}
