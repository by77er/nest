#![allow(clippy::result_large_err)]
//! End-to-end nestd test: mock FleetDO (WebSocket), fake driver with an in-process fake guest
//! agent (behind the vsock emulator), fake agent runner and fake nest-proxy.
//!
//! Covers: hello/hello_ack, ordered command execution with exactly one `command_result` each,
//! dedup of redelivered commands, stale-epoch rejection, agent start (ids only to the runner),
//! `agent_attach`/`agent_detach` (guest slot, the gateway's client set), the gateway link (keys,
//! upserts, removal on fence), the guest's version in `running`, port events, commit CAS
//! round-trip, and self-fencing (proxy drop, runner fence, gateway remove, `fenced` state,
//! salvage commit) when heartbeats stop being acknowledged.

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
use nest_protocol::host::gateway_link::{GatewayCommand, GatewayEvent};
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

/// While `held` is set, the fake guest answers the next `agent_attach` only after `release`.
#[derive(Default)]
struct AttachLatch {
    held: AtomicBool,
    release: tokio::sync::Notify,
}

struct FakeDriver {
    seen: Seen,
    latch: Option<Arc<AttachLatch>>,
    /// The next VM start fails (a create that fails, to be retried at the same epoch).
    fail_next_start: Arc<AtomicBool>,
    /// Sandboxes whose VM was stopped, in order.
    stopped: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl Driver for FakeDriver {
    fn name(&self) -> &'static str {
        "fake"
    }
    async fn create(&self, spec: VmSpec) -> std::io::Result<Box<dyn Vm>> {
        std::fs::create_dir_all(&spec.vm_dir)?;
        Ok(Box::new(FakeVm {
            spec,
            seen: self.seen.clone(),
            latch: self.latch.clone(),
            fail_next_start: self.fail_next_start.clone(),
            stopped: self.stopped.clone(),
            emu: None,
            guest: None,
        }))
    }
}

struct FakeVm {
    spec: VmSpec,
    seen: Seen,
    latch: Option<Arc<AttachLatch>>,
    fail_next_start: Arc<AtomicBool>,
    stopped: Arc<Mutex<Vec<String>>>,
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
        if self.fail_next_start.swap(false, Ordering::SeqCst) {
            return Err(std::io::Error::other("fake VM failed to start"));
        }
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
        self.guest = Some(fake_guest(&gdir, self.seen.clone(), self.latch.clone()));
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
        self.stopped.lock().unwrap().push(self.spec.sandbox.0.clone());
        if let Some(g) = self.guest.take() {
            g.abort();
        }
        self.emu = None;
        Ok(())
    }
}

fn fake_guest(dir: &Path, seen: Seen, latch: Option<Arc<AttachLatch>>) -> tokio::task::JoinHandle<()> {
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
                    if let (ControlBody::AgentAttach { .. }, Some(l)) = (&cf.body, &latch)
                        && l.held.load(Ordering::SeqCst)
                    {
                        l.release.notified().await;
                    }
                    // `agt_fail` is refused; `agt_bye` is attached, then the connection drops (the
                    // guest agent restarted: nestd reconnects and configures it again).
                    let attaching = match &cf.body {
                        ControlBody::AgentAttach { slot } => slot.agent_id.0.clone(),
                        _ => String::new(),
                    };
                    let body = if attaching == "agt_fail" {
                        ControlBody::Error { error: ErrorBody { code: "attach_failed".into(), message: "refused".into(), retryable: false } }
                    } else {
                        ControlBody::Ok {}
                    };
                    let ok = ControlFrame { id: None, reply_to: cf.id, body };
                    if s.write_all(&frame::encode_json(&ok).unwrap()).await.is_err() || attaching == "agt_bye" {
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
    /// Any other frame FleetDO may push (a `binding_key`, for example).
    frames: mpsc::UnboundedSender<FleetToHost>,
    partition: Arc<AtomicBool>,
    /// Fail the next events batch with a retryable error (no ack), like FleetDO's handler error.
    fail_next_events: Arc<AtomicBool>,
    /// Lose this many `commit_result` answers (the commit itself is applied, as SandboxDO would).
    lose_commit_answers: Arc<std::sync::atomic::AtomicUsize>,
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
    let lose_commit_answers = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<Command>>();
    let (ftx, mut frx) = mpsc::unbounded_channel::<FleetToHost>();
    let (log2, part, fail, lose) = (log.clone(), partition.clone(), fail_next_events.clone(), lose_commit_answers.clone());
    tokio::spawn(async move {
        let mut seq = 0u64;
        let mut last_event_seq: Option<u64> = None;
        // SandboxDO's commit compare-and-set: one head per sandbox, outcomes stored per request.
        let mut heads: BTreeMap<SandboxId, GenerationId> = BTreeMap::new();
        let mut outcomes: BTreeMap<RequestId, CommitOutcome> = BTreeMap::new();
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
                    frame = frx.recv() => {
                        let Some(frame) = frame else { return };
                        if ws.send(send(frame)).await.is_err() { break; }
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
                                // Answer commit requests (CAS): committed, orphaned for salvage, or
                                // rejected on a parent mismatch; a repeated request gets its stored outcome.
                                let mut answers = vec![];
                                for e in &events {
                                    if let HostEventBody::CommitRequest { request, sandbox, epoch, parent, kind, disk_manifest, mem_manifest, reason } = &e.body {
                                        let generation = GenerationRecord {
                                            id: GenerationId(format!("gen_{}", request.0)), sandbox: sandbox.clone(), parent: parent.clone(), epoch: *epoch,
                                            kind: *kind, disk_manifest: disk_manifest.clone(), mem_manifest: mem_manifest.clone(), reason: *reason, created_ms: 0,
                                        };
                                        let outcome = outcomes.entry(request.clone()).or_insert_with(|| {
                                            if *reason == CommitReason::Salvage {
                                                CommitOutcome::Orphaned { generation }
                                            } else if parent.as_ref() != heads.get(sandbox) {
                                                CommitOutcome::Rejected { reason: "parent_mismatch".into(), head: heads.get(sandbox).cloned() }
                                            } else {
                                                heads.insert(sandbox.clone(), generation.id.clone());
                                                CommitOutcome::Committed { generation }
                                            }
                                        }).clone();
                                        if lose.load(Ordering::SeqCst) > 0 {
                                            lose.fetch_sub(1, Ordering::SeqCst);
                                            continue;
                                        }
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
    MockFleet { url, log, commands: tx, frames: ftx, partition, fail_next_events, lose_commit_answers }
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

struct FakeGateway {
    got: Arc<Mutex<Vec<GatewayCommand>>>,
    /// Frames that did not decode as a `GatewayCommand` (a contract bug, asserted empty).
    errors: Arc<Mutex<Vec<String>>>,
}

/// A fake sandbox gateway: connects to `gateway.sock`, says hello, records every command and
/// answers pings.
async fn fake_gateway(path: &Path) -> FakeGateway {
    let got = Arc::new(Mutex::new(vec![]));
    let errors = Arc::new(Mutex::new(vec![]));
    let s = loop {
        match UnixStream::connect(path).await {
            Ok(s) => break s,
            Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
        }
    };
    let mut f = Framed::new(s, LengthDelimitedCodec::new());
    let hello = GatewayEvent::Hello { protocol_version: HOST_PROTOCOL_VERSION, instance_id: "fakegw".into(), listen: "127.0.0.1:18790".into() };
    f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
    let (got2, errors2) = (got.clone(), errors.clone());
    tokio::spawn(async move {
        while let Some(Ok(b)) = f.next().await {
            let cmd: GatewayCommand = match serde_json::from_slice(&b) {
                Ok(c) => c,
                Err(e) => {
                    errors2.lock().unwrap().push(format!("{e}: {}", String::from_utf8_lossy(&b)));
                    continue;
                }
            };
            if matches!(cmd, GatewayCommand::Ping) {
                let _ = f.send(bytes::Bytes::from(serde_json::to_vec(&GatewayEvent::Pong).unwrap())).await;
            }
            got2.lock().unwrap().push(cmd);
        }
    });
    FakeGateway { got, errors }
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
        "gateway_url": "ws://127.0.0.1:18790",
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let run_dir = dir.path().join("run");
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: seen.clone(), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.unwrap();
    let runner = fake_runner(&run_dir.join("runner.sock")).await;
    let proxy = fake_proxy(run_dir.join("proxy.sock"));
    let gw = fake_gateway(&run_dir.join("gateway.sock")).await;
    let gateway = gw.got.clone();

    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let hello = fleet.log.lock().unwrap().hellos[0].clone();
    assert_eq!(hello.host.0, "hst_t");
    assert!(hello.sandboxes.is_empty());
    assert_eq!(hello.gateway_url.as_deref(), Some("ws://127.0.0.1:18790"), "the fleet hello carries the configured gateway URL");

    // 0. The gateway's replay: hello_ack, the (empty) key set, no sandboxes, resync_done. Then the
    // keys FleetDO pushes arrive as a delta.
    wait_until("gateway resync", || gateway.lock().unwrap().iter().any(|c| matches!(c, GatewayCommand::ResyncDone))).await;
    {
        let g = gateway.lock().unwrap();
        assert!(matches!(g[0], GatewayCommand::HelloAck { ref host_id, .. } if host_id.0 == "hst_t"));
        assert!(matches!(g[1], GatewayCommand::KeyUpdate { ref keys } if keys.is_empty()));
        assert!(matches!(g[2], GatewayCommand::ResyncDone));
    }
    let key = nest_protocol::gateway::BindingKey { kid: "k1".into(), public_key: "pk".into() };
    fleet.frames.send(FleetToHost::BindingKey { keys: vec![key.clone()] }).unwrap();
    wait_until("binding key forwarded to the gateway", || gateway.lock().unwrap().iter().any(|c| matches!(c, GatewayCommand::KeyUpdate { keys } if keys == &vec![key.clone()]))).await;

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
    // `running` carries the guest's version (from the fake guest's hello: v1, no capabilities).
    match fleet.wait_event("running", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Running, .. })).await {
        HostEventBody::SandboxState { guest, .. } => assert_eq!(guest, Some(nest_protocol::gateway::GuestInfo { protocol_version: 1, capabilities: vec![] })),
        other => panic!("running: {other:?}"),
    }
    wait_until("ack of batch 1", || fleet.log.lock().unwrap().acks.contains(&1)).await;
    assert!(seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::Configure { epoch: Epoch(1), .. })));
    wait_until("proxy upsert", || proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxUpsert { .. }))).await;
    fleet.wait_event("port opened", |b| matches!(b, HostEventBody::Workstream { event } if matches!(event.kind, WorkstreamEventKind::PortOpened { port: 5173 }))).await;
    // The gateway learned the sandbox: its epoch, the vsock socket, no clients yet, the guest.
    let upserts = |g: &Vec<GatewayCommand>| g.iter().filter(|c| matches!(c, GatewayCommand::SandboxUpsert { sandbox, .. } if sandbox.0 == "sbx_1")).cloned().collect::<Vec<_>>();
    wait_until("gateway upsert", || !upserts(&gateway.lock().unwrap()).is_empty()).await;
    match upserts(&gateway.lock().unwrap()).last().unwrap() {
        GatewayCommand::SandboxUpsert { epoch, vsock_uds_path, clients, guest, .. } => {
            assert_eq!(*epoch, Epoch(1));
            assert!(vsock_uds_path.ends_with("vsock.sock"));
            assert!(clients.is_empty());
            assert_eq!(guest.as_ref().map(|g| g.protocol_version), Some(1));
        }
        other => panic!("upsert: {other:?}"),
    }

    // 2. Start a worker: the runner gets the sandbox's id and epoch, never a socket path.
    let start = AgentStart {
        agent: AgentId("agt_w".into()),
        role: AgentRole::Worker,
        workstream: WorkstreamId("ws_1".into()),
        resume: None,
        hands: Some(HandsBinding { sandbox: sbx.clone(), epoch: Epoch(1) }),
        launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: "w".into() } },
        oauth_token: "oauth".into(),
        session_ws_url: "ws://x".into(),
    };
    fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(start))]).unwrap();
    assert!(matches!(fleet.result("cmd_agent").await, CommandOutcome::Ok { .. }));
    wait_until("runner agent_start", || {
        runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_w" && s.start.hands.as_ref().is_some_and(|h| h.sandbox == sbx)))
    })
    .await;
    assert!(!seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::AgentAttach { .. })), "a brain start configures no guest slot");

    // 2a. attach: the guest slot (explicit proxy port 3128, the cwd), and the gateway's client set.
    let attach = |id: &str, epoch: u64, cwd: Option<&str>| cmd(id, CommandBody::AgentAttach { sandbox: sbx.clone(), epoch: Epoch(epoch), agent: AgentId("agt_w".into()), cwd: cwd.map(Into::into) });
    fleet.commands.send(vec![attach("cmd_attach", 1, Some("/workspace/app"))]).unwrap();
    assert!(matches!(fleet.result("cmd_attach").await, CommandOutcome::Ok { .. }));
    assert!(seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::AgentAttach { slot } if slot.proxy_port == 3128 && slot.cwd == "/workspace/app")));
    wait_until("gateway learns the client", || matches!(upserts(&gateway.lock().unwrap()).last(), Some(GatewayCommand::SandboxUpsert { clients, .. }) if clients == &vec!["agt_w".to_string()])).await;
    // Idempotent: a second attach keeps the slot's port; a stale epoch is refused.
    fleet.commands.send(vec![attach("cmd_attach2", 1, None), attach("cmd_attach_stale", 7, None)]).unwrap();
    assert!(matches!(fleet.result("cmd_attach2").await, CommandOutcome::Ok { .. }));
    match fleet.result("cmd_attach_stale").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("stale attach: {other:?}"),
    }
    let attaches: Vec<u16> = seen.lock().unwrap().iter().filter_map(|b| match b { ControlBody::AgentAttach { slot } => Some(slot.proxy_port), _ => None }).collect();
    assert_eq!(attaches, vec![3128, 3128], "re-attach reuses the slot; the stale attach never reaches the guest");

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

    // 4b. detach: the slot goes, the gateway's client set empties; detaching again is `ok`.
    let detach = |id: &str| cmd(id, CommandBody::AgentDetach { sandbox: sbx.clone(), epoch: Epoch(1), agent: AgentId("agt_w".into()), kill_processes: true });
    fleet.commands.send(vec![detach("cmd_detach"), detach("cmd_detach_again")]).unwrap();
    assert!(matches!(fleet.result("cmd_detach").await, CommandOutcome::Ok { detail: None }));
    assert!(matches!(fleet.result("cmd_detach_again").await, CommandOutcome::Ok { detail: Some(_) }));
    assert!(seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::AgentDetach { kill_processes: true, .. })));
    wait_until("gateway forgets the client", || matches!(upserts(&gateway.lock().unwrap()).last(), Some(GatewayCommand::SandboxUpsert { clients, .. }) if clients.is_empty())).await;
    // The brain stays bound (ids only) for fencing; re-attach for the fence check below.
    fleet.commands.send(vec![attach("cmd_attach3", 1, None)]).unwrap();
    assert!(matches!(fleet.result("cmd_attach3").await, CommandOutcome::Ok { .. }));

    // 5. Partition: the host self-fences ~500 ms after the last acknowledged heartbeat (locally:
    // proxy drop + runner fence + gateway remove), then reports it all once the partition heals.
    let t0 = std::time::Instant::now();
    fleet.partition.store(true, Ordering::SeqCst);
    wait_until("proxy drop", || proxy.lock().unwrap().iter().any(|c| matches!(c, ProxyCommand::SandboxDrop { .. }))).await;
    let elapsed = t0.elapsed();
    assert!(elapsed >= Duration::from_millis(350) && elapsed < Duration::from_secs(3), "fence after {elapsed:?}");
    wait_until("runner fence", || runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::Fence { .. }))).await;
    wait_until("gateway remove", || gateway.lock().unwrap().iter().any(|c| matches!(c, GatewayCommand::SandboxRemove { sandbox } if sandbox.0 == "sbx_1"))).await;
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
    assert_eq!(counts.get("cmd_attach"), Some(&1));
    assert_eq!(counts.get("cmd_detach"), Some(&1));
    assert_eq!(counts.get("cmd_ckpt"), Some(&2));
    assert!(gw.errors.lock().unwrap().is_empty(), "undecodable gateway commands: {:?}", gw.errors.lock().unwrap());
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
        Ok(Box::new(FakeVm { spec, seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: Arc::default(), stopped: Arc::default(), emu: None, guest: None }))
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
        let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
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
                    workstream: WorkstreamId("ws_1".into()),
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
    dir: tempfile::TempDir,
    fleet: MockFleet,
    _runner: Arc<Mutex<Vec<RunnerCommand>>>,
    proxy: Arc<Mutex<Vec<ProxyCommand>>>,
    gateway: FakeGateway,
    /// Everything the fake guests received.
    seen: Seen,
    /// Sandboxes whose VM was stopped.
    stopped: Arc<Mutex<Vec<String>>>,
}

async fn start_host() -> Started {
    start_host_opts(None, 5000).await
}

async fn start_host_with(proxy_ca: Option<(CaCertificate, nest_protocol::host::Secret)>) -> Started {
    start_host_opts(proxy_ca, 5000).await
}

async fn start_host_opts(proxy_ca: Option<(CaCertificate, nest_protocol::host::Secret)>, commit_timeout_ms: u64) -> Started {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "role": "burst", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": commit_timeout_ms,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca, tunnel_token: None, gateway_url: None };
    let (seen, stopped): (Seen, Arc<Mutex<Vec<String>>>) = (Arc::default(), Arc::default());
    let driver = FakeDriver { seen: seen.clone(), latch: None, fail_next_start: Arc::default(), stopped: stopped.clone() };
    let host = Host::start(cfg, enrolled, Some(Arc::new(driver))).await.unwrap();
    let runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    let gateway = fake_gateway(&dir.path().join("run/gateway.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    Started { _host: host, dir, fleet, _runner: runner, proxy, gateway, seen, stopped }
}

/// Whether `pid` is still a live process (a zombie counts as dead: it has been killed).
fn alive(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Ok(s) => !s.lines().any(|l| l.starts_with("State:") && l.contains('Z')),
        Err(_) => false,
    }
}

/// nestd's cloudflared log lines for the whole test binary (a process has one global subscriber;
/// tests tell their own lines apart by their temp paths).
fn cloudflared_logs() -> Arc<Mutex<Vec<u8>>> {
    static LOGS: std::sync::OnceLock<Arc<Mutex<Vec<u8>>>> = std::sync::OnceLock::new();
    LOGS.get_or_init(|| {
        let buf: Arc<Mutex<Vec<u8>>> = Arc::default();
        struct Sink(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let b = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new("nestd::cloudflared=info"))
            .with_writer(move || Sink(b.clone()))
            .with_ansi(false)
            .finish();
        let _ = tracing::subscriber::set_global_default(sub);
        buf
    })
    .clone()
}

fn tunnel_config(dir: &Path, fleet_url: &str, bin: &Path, user: Option<String>) -> Config {
    tunnel_config_with_metrics(dir, fleet_url, bin, user, "127.0.0.1:1")
}

fn tunnel_config_with_metrics(dir: &Path, fleet_url: &str, bin: &Path, user: Option<String>, metrics: &str) -> Config {
    serde_json::from_value(serde_json::json!({
        "role": "burst", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet_url},
        "run_dir": dir.join("run"), "state_dir": dir.join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": 5000,
        "gateway_url": "ws://127.0.0.1:18790", "cloudflared_bin": bin, "cloudflared_user": user, "cloudflared_metrics": metrics,
    }))
    .unwrap()
}

fn tunnel_enrolled(fleet_url: &str) -> Enrolled {
    Enrolled {
        host: HostId("hst_t".into()),
        host_token: nest_protocol::host::Secret("tok".into()),
        host_token_expires_ms: i64::MAX,
        fleet_ws_url: fleet_url.into(),
        proxy_ca: None,
        tunnel_token: Some(nest_protocol::host::Secret("tunnel-token".into())),
        gateway_url: Some("wss://hst_t-gw-nest.example.dev".into()),
    }
}

/// A loopback stand-in for cloudflared's metrics server: `/ready` is 503 until `ready` is set.
async fn fake_metrics() -> (String, Arc<std::sync::atomic::AtomicBool>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let r = ready.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let (status, body) = if r.load(std::sync::atomic::Ordering::SeqCst) { ("200 OK", "{\"status\":200}") } else { ("503 Service Unavailable", "{\"status\":503}") };
            let _ = s.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            let _ = s.shutdown().await;
        }
    });
    (addr, ready)
}

/// With a cloudflared binary and user configured and a tunnel token from enrollment, the host runs
/// the tunnel as its child, told where to serve its metrics; the fleet hello still carries the
/// configured `gateway_url`, not the control plane's, and reports the tunnel as `connecting` until
/// `/ready` answers 200, which goes out as a `tunnel_state` event; shutting the host down sends
/// the child SIGTERM, after which it is gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunnel_child_runs_with_the_host_and_is_terminated_at_shutdown() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let (metrics, ready) = fake_metrics().await;
    let log = dir.path().join("cloudflared.log");
    let bin = dir.path().join("cloudflared");
    std::fs::write(&bin, format!("#!/bin/sh\necho pid=$$ >> {l}\nwhile [ $# -gt 0 ]; do [ \"$1\" = --metrics ] && echo metrics=$2 >> {l}; shift; done\ntrap 'echo term >> {l}; exit 0' TERM\nwhile :; do sleep 0.1; done\n", l = log.display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The configured user: the test's own, the only one an unprivileged test can switch to.
    let me = nix::unistd::User::from_uid(nix::unistd::getuid()).unwrap().unwrap().name;
    let cfg = tunnel_config_with_metrics(dir.path(), &fleet.url, &bin, Some(me), &metrics);
    let host = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.unwrap();
    let _runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let _proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    wait_until("cloudflared spawned", || log.exists()).await;
    let pid: i32 = std::fs::read_to_string(&log).unwrap().lines().next().unwrap().strip_prefix("pid=").unwrap().parse().unwrap();
    assert!(alive(pid));
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let hello = fleet.log.lock().unwrap().hellos[0].clone();
    assert_eq!(hello.gateway_url.as_deref(), Some("ws://127.0.0.1:18790"), "the hello keeps nestd's configured URL");
    assert_eq!(hello.tunnel, TunnelState::Connecting, "planned but not served yet");
    assert!(std::fs::read_to_string(&log).unwrap().contains(&format!("metrics={metrics}\n")), "cloudflared is told where to serve /ready");
    assert!(!fleet.log.lock().unwrap().events.iter().any(|e| matches!(e.body, HostEventBody::TunnelState { .. })), "no change yet");
    ready.store(true, std::sync::atomic::Ordering::SeqCst);
    fleet.wait_event("tunnel connected", |b| matches!(b, HostEventBody::TunnelState { state: TunnelState::Connected })).await;
    host.shutdown().await;
    assert!(!alive(pid));
    assert!(std::fs::read_to_string(&log).unwrap().ends_with("\nterm\n"), "the child saw SIGTERM before it died");
}

/// A configured binary that is missing does not stop the host: it enrolls and says hello, and the
/// failed start is logged on every retry.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_cloudflared_binary_is_logged_and_does_not_stop_the_host() {
    let logs = cloudflared_logs();
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let bin = dir.path().join("no-such-cloudflared");
    let cfg = tunnel_config(dir.path(), &fleet.url, &bin, None);
    let host = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.unwrap();
    let _runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let _proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let mine = || {
        let text = String::from_utf8_lossy(&logs.lock().unwrap()).into_owned();
        text.lines().filter(|l| l.contains("cloudflared failed to start") && l.contains(&bin.display().to_string())).count()
    };
    // The second attempt comes after the 1 s minimum backoff.
    wait_until("the failed start to be logged twice", || mine() >= 2).await;
    host.shutdown().await;
}

/// cloudflared is started last: a `Host::start` that fails after deciding to run it (here on an
/// unusable `run_dir`) leaves no child behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_start_leaves_no_tunnel_child() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let log = dir.path().join("cloudflared.log");
    let bin = dir.path().join("cloudflared");
    std::fs::write(&bin, format!("#!/bin/sh\necho pid=$$ >> {}\nexit 0\n", log.display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut cfg = tunnel_config(dir.path(), &fleet.url, &bin, None);
    cfg.run_dir = "/proc/no-such-dir/run".into();
    let err = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.err().unwrap();
    assert!(!err.to_string().contains("cloudflared"), "the failure is elsewhere: {err:#}");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!log.exists(), "cloudflared was started although the host did not");
}

/// A `cloudflared_user` that does not exist is a configuration error: the host does not start.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_cloudflared_user_fails_startup() {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg = tunnel_config(dir.path(), &fleet.url, Path::new("/opt/nest/bin/cloudflared"), Some("no-such-user-nest".into()));
    let err = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.err().unwrap();
    assert!(err.to_string().contains("no-such-user-nest"), "{err}");
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

/// Gateway review #1: a fence lands while the guest still holds an `agent_attach` reply. The
/// attach must answer `stale_epoch`, not `ok`, and the gateway's log for the sandbox must end
/// with `sandbox_remove`: the late slot sync after the fence is refused by the tombstone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fence_during_attach_answers_stale_epoch_and_never_re_adds_the_sandbox() {
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
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let latch = Arc::new(AttachLatch::default());
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: seen.clone(), latch: Some(latch.clone()), fail_next_start: Arc::default(), stopped: Arc::default() }))).await.unwrap();
    let _runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let _proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    let gw = fake_gateway(&dir.path().join("run/gateway.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;

    let sbx = SandboxId("sbx_1".into());
    fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(matches!(fleet.result("cmd_create").await, CommandOutcome::Ok { .. }));
    wait_until("gateway upsert", || gw.got.lock().unwrap().iter().any(|c| matches!(c, GatewayCommand::SandboxUpsert { .. }))).await;

    // The guest holds the attach reply; the fence lands meanwhile; then the reply is released.
    latch.held.store(true, Ordering::SeqCst);
    fleet.commands.send(vec![cmd("cmd_attach", CommandBody::AgentAttach { sandbox: sbx.clone(), epoch: Epoch(1), agent: AgentId("agt_w".into()), cwd: None })]).unwrap();
    wait_until("guest holds the attach", || seen.lock().unwrap().iter().any(|b| matches!(b, ControlBody::AgentAttach { .. }))).await;
    fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![sbx.clone()], reason: "test".into() })]).unwrap();
    fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    latch.held.store(false, Ordering::SeqCst);
    latch.release.notify_waiters();
    match fleet.result("cmd_attach").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("attach after a fence: {other:?}"),
    }
    // Everything the fence and the attach's cleanup send has arrived; the sandbox's last word is `sandbox_remove`.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let last = gw.got.lock().unwrap().iter().rev().find(|c| matches!(c, GatewayCommand::SandboxUpsert { sandbox, .. } | GatewayCommand::SandboxRemove { sandbox } if sandbox == &sbx)).cloned();
    assert!(matches!(last, Some(GatewayCommand::SandboxRemove { .. })), "a fenced sandbox was re-added to the gateway: {last:?}");
    assert!(gw.errors.lock().unwrap().is_empty());
}

/// Integrated review: a `sandbox_create` that fails is retried by SandboxDO at the SAME epoch. The
/// failed attempt's teardown must leave no tombstone, so the retried create reaches the gateway
/// (entry present at epoch 1, with its vsock socket and the guest's version: bindable).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_create_retried_at_the_same_epoch_reaches_the_gateway() {
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
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let fail = Arc::new(AtomicBool::new(true));
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: Arc::new(Mutex::new(vec![])), latch: None, fail_next_start: fail.clone(), stopped: Arc::default() }))).await.unwrap();
    let _runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let _proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    let gw = fake_gateway(&dir.path().join("run/gateway.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;

    let sbx = SandboxId("sbx_1".into());
    fleet.commands.send(vec![create("cmd_create_1", "sbx_1")]).unwrap();
    assert!(matches!(fleet.result("cmd_create_1").await, CommandOutcome::Error { .. }), "the first create fails");
    fleet.wait_event("failed", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Failed, .. })).await;
    assert!(!fail.load(Ordering::SeqCst));

    // SandboxDO retries at the same epoch.
    fleet.commands.send(vec![create("cmd_create_2", "sbx_1")]).unwrap();
    assert!(matches!(fleet.result("cmd_create_2").await, CommandOutcome::Ok { .. }), "the retried create succeeds");
    fleet.wait_event("running", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Running, epoch: Epoch(1), .. })).await;
    wait_until("gateway upsert after the retry", || {
        matches!(
            gw.got.lock().unwrap().iter().rev().find(|c| matches!(c, GatewayCommand::SandboxUpsert { sandbox, .. } | GatewayCommand::SandboxRemove { sandbox } if sandbox == &sbx)),
            Some(GatewayCommand::SandboxUpsert { epoch: Epoch(1), vsock_uds_path, guest: Some(_), .. }) if vsock_uds_path.ends_with("vsock.sock")
        )
    })
    .await;
    assert!(gw.errors.lock().unwrap().is_empty());
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

// ---------------------------------------------------------------------------------------------
// Duplicated-state review (nestd and guest-proxy findings)
// ---------------------------------------------------------------------------------------------

fn attach_cmd(id: &str, sandbox: &str, agent: &str) -> Command {
    cmd(id, CommandBody::AgentAttach { sandbox: SandboxId(sandbox.into()), epoch: Epoch(1), agent: AgentId(agent.into()), cwd: None })
}

fn is_ok(o: &CommandOutcome) -> bool {
    matches!(o, CommandOutcome::Ok { .. })
}

/// The last gateway command about `sandbox` (an upsert or a remove).
fn last_gateway_word(g: &FakeGateway, sandbox: &str) -> Option<GatewayCommand> {
    g.got
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|c| matches!(c, GatewayCommand::SandboxUpsert { sandbox: s, .. } | GatewayCommand::SandboxRemove { sandbox: s } if s.0 == sandbox))
        .cloned()
}

/// nestd review #2: a fence stops the VM at once (its memory goes back to the host) and keeps
/// only the disk, which salvage reads. `sandbox_destroy` at the fenced (old) epoch then reaps the
/// rest: the disk, and the `fenced` row every hello would otherwise report forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fence_stops_the_vm_and_a_destroy_at_the_old_epoch_reaps_it() {
    let h = start_host().await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    let disk = h.dir.path().join("state/sandboxes/sbx_1/disk.img");
    assert!(disk.exists());

    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![sbx.clone()], reason: "test".into() })]).unwrap();
    h.fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    wait_until("the fenced VM is stopped", || h.stopped.lock().unwrap().contains(&"sbx_1".to_string())).await;
    h.fleet.wait_event("salvage", |b| matches!(b, HostEventBody::CommitRequest { reason: CommitReason::Salvage, .. })).await;
    assert!(disk.exists(), "the disk stays until destroy");

    h.fleet.commands.send(vec![cmd("cmd_destroy", CommandBody::SandboxDestroy { sandbox: sbx.clone(), epoch: Epoch(1) })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_destroy").await));
    assert!(!disk.parent().unwrap().exists(), "the fenced incarnation's state dir is gone");
    // The next hello reports nothing for it.
    let n = h.fleet.log.lock().unwrap().hellos.len();
    h.fleet.fail_next_events.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![cmd("cmd_destroy_again", CommandBody::SandboxDestroy { sandbox: sbx, epoch: Epoch(1) })]).unwrap();
    wait_until("reconnect", || h.fleet.log.lock().unwrap().hellos.len() > n).await;
    let hello = h.fleet.log.lock().unwrap().hellos.last().cloned().unwrap();
    assert!(hello.sandboxes.is_empty(), "a destroyed fenced sandbox is still reported: {:?}", hello.sandboxes);
}

/// nestd review #1/#3, end to end: the runner connection drops (the runner kills its brains), so
/// the brain is reported `crashed`, which AgentDO restarts with a current `agent_start`. The
/// runner that reconnects gets no replay of the stale start.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_runner_reports_its_brains_exited_and_nothing_is_replayed() {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "role": "burst", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: Arc::default(), latch: None, fail_next_start: Arc::default(), stopped: Arc::default() }))).await.unwrap();
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let sock = dir.path().join("run/runner.sock");
    let connect = || async {
        let mut f = Framed::new(UnixStream::connect(&sock).await.unwrap(), LengthDelimitedCodec::new());
        let hello = RunnerEvent::Hello { protocol_version: HOST_PROTOCOL_VERSION, runner_version: "fake".into(), pid: 1 };
        f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
        f
    };
    // Every command the runner receives within `window`.
    async fn drain(f: &mut Framed<UnixStream, LengthDelimitedCodec>, window: Duration) -> Vec<RunnerCommand> {
        let mut got = vec![];
        let end = tokio::time::Instant::now() + window;
        while let Ok(Some(Ok(b))) = tokio::time::timeout_at(end, f.next()).await {
            got.push(serde_json::from_slice(&b).unwrap());
        }
        got
    }

    let mut r = connect().await;
    let start = AgentStart {
        agent: AgentId("agt_c".into()),
        role: AgentRole::Captain,
        workstream: WorkstreamId("ws_1".into()),
        resume: None,
        hands: None,
        launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: "c".into() } },
        oauth_token: "oauth".into(),
        session_ws_url: "ws://x".into(),
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(start))]).unwrap();
    assert!(is_ok(&fleet.result("cmd_agent").await));
    assert!(drain(&mut r, Duration::from_millis(300)).await.iter().any(|c| matches!(c, RunnerCommand::AgentStart(_))));
    let started = RunnerEvent::AgentStarted { agent: AgentId("agt_c".into()), pid: 9, session: SessionId("ses_1".into()), claude_version: "t".into(), capabilities: vec![] };
    r.send(bytes::Bytes::from(serde_json::to_vec(&started).unwrap())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    drop(r);
    fleet.wait_event("the lost brain reported", |b| matches!(b, HostEventBody::AgentExited { agent, reason, .. } if agent.0 == "agt_c" && *reason == AgentExitReason::Crashed)).await;
    let mut r = connect().await;
    let got = drain(&mut r, Duration::from_millis(500)).await;
    assert!(got.iter().any(|c| matches!(c, RunnerCommand::HelloAck { .. })));
    assert!(!got.iter().any(|c| matches!(c, RunnerCommand::AgentStart(_))), "a stale agent_start was replayed: {got:?}");
}

/// nestd review #5 / guest-proxy review #5: an attach the guest refused leaves no slot behind in
/// the guest connection's configuration. When the guest reconnects, its `configure` names only
/// the attached agents, each with its own proxy port (the refused agent's slot went to another).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_attach_leaves_no_slot_in_the_guest_configuration() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    h.fleet.commands.send(vec![attach_cmd("cmd_fail", "sbx_1", "agt_fail")]).unwrap();
    assert!(!is_ok(&h.fleet.result("cmd_fail").await), "the guest refused agt_fail");
    h.fleet.commands.send(vec![attach_cmd("cmd_x", "sbx_1", "agt_x"), attach_cmd("cmd_bye", "sbx_1", "agt_bye")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_x").await));
    assert!(is_ok(&h.fleet.result("cmd_bye").await));
    let configures = || -> Vec<Vec<nest_protocol::guest::AgentSlot>> {
        h.seen.lock().unwrap().iter().filter_map(|b| match b { ControlBody::Configure { agents, .. } => Some(agents.clone()), _ => None }).collect()
    };
    wait_until("the guest reconnected and was configured again", || configures().len() >= 2).await;
    let slots = configures().pop().unwrap();
    let mut agents: Vec<&str> = slots.iter().map(|s| s.agent_id.0.as_str()).collect();
    agents.sort();
    assert_eq!(agents, vec!["agt_bye", "agt_x"], "{slots:?}");
    let ports: std::collections::BTreeSet<u16> = slots.iter().map(|s| s.proxy_port).collect();
    assert_eq!(ports.len(), slots.len(), "two agents share a proxy port: {slots:?}");
}

/// nestd review #6: a suspended sandbox is not reachable through the gateway. An attach while it
/// is suspended (SandboxDO retries those) must not re-add it; resume does, with the client.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_attach_while_suspended_does_not_make_the_sandbox_reachable() {
    let h = start_host().await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    wait_until("gateway upsert", || matches!(last_gateway_word(&h.gateway, "sbx_1"), Some(GatewayCommand::SandboxUpsert { .. }))).await;
    // Memory mode: this driver keeps the paused VM (and its guest connection) locally.
    h.fleet.commands.send(vec![cmd("cmd_suspend", CommandBody::SandboxSuspend { sandbox: sbx.clone(), epoch: Epoch(1), mode: SuspendMode::Memory })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_suspend").await));
    wait_until("gateway remove", || matches!(last_gateway_word(&h.gateway, "sbx_1"), Some(GatewayCommand::SandboxRemove { .. }))).await;

    h.fleet.commands.send(vec![attach_cmd("cmd_attach", "sbx_1", "agt_w")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_attach").await));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let last = last_gateway_word(&h.gateway, "sbx_1");
    assert!(matches!(last, Some(GatewayCommand::SandboxRemove { .. })), "a suspended sandbox was re-added to the gateway: {last:?}");

    h.fleet.commands.send(vec![cmd("cmd_resume", CommandBody::SandboxResume { sandbox: sbx, epoch: Epoch(1) })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_resume").await));
    wait_until("resume re-adds it with the client", || {
        matches!(last_gateway_word(&h.gateway, "sbx_1"), Some(GatewayCommand::SandboxUpsert { clients, .. }) if clients == vec!["agt_w".to_string()])
    })
    .await;
    assert!(h.gateway.errors.lock().unwrap().is_empty());
}

/// nestd review #4: a commit's answer is lost (timeout) after SandboxDO moved its head. The next
/// commit asks again under the same request id and adopts the stored outcome, instead of sending
/// a new request with the stale parent (`parent_mismatch`, which fences the sandbox).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_commit_whose_answer_was_lost_is_asked_again_under_the_same_id() {
    let h = start_host_opts(None, 400).await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    let ckpt = |id: &str| cmd(id, CommandBody::SandboxCheckpoint { sandbox: sbx.clone(), epoch: Epoch(1), reason: CommitReason::Checkpoint });

    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    h.fleet.commands.send(vec![ckpt("cmd_ck1")]).unwrap();
    match h.fleet.result("cmd_ck1").await {
        CommandOutcome::Error { error } => assert!(error.retryable && error.message.contains("timed out"), "{error:?}"),
        other => panic!("the first checkpoint must time out: {other:?}"),
    }
    h.fleet.commands.send(vec![ckpt("cmd_ck2")]).unwrap();
    let generation = match h.fleet.result("cmd_ck2").await {
        CommandOutcome::Ok { detail: Some(d) } => d["generation"].as_str().unwrap().to_string(),
        other => panic!("the retried checkpoint must succeed: {other:?}"),
    };
    let events = h.fleet.log.lock().unwrap().events.clone();
    let requests: Vec<String> = events.iter().filter_map(|e| match &e.body { HostEventBody::CommitRequest { request, .. } => Some(request.0.clone()), _ => None }).collect();
    assert_eq!(requests.len(), 2, "{requests:?}");
    assert_eq!(requests[0], requests[1], "the lost commit is asked again under its own id");
    assert_eq!(generation, format!("gen_{}", requests[0]), "the stored outcome's generation is adopted");
    assert!(!events.iter().any(|e| matches!(e.body, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })), "fenced after a lost commit answer");
}

/// nestd review #5(b): an attach to a sandbox suspended to disk (no guest connection) must not
/// bind the agent's explicit-proxy listener; otherwise every later attach, after resume
/// included, hits EADDRINUSE on that port.
#[test]
fn an_attach_without_a_guest_binds_no_listener() {
    if !nestd::net::reexec_in_userns("an_attach_without_a_guest_binds_no_listener") {
        return;
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    rt.block_on(async {
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
        let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
        let _host = Host::start(cfg, enrolled, Some(Arc::new(NetnsCapture(Arc::new(Mutex::new(None)))))).await.unwrap();
        let _received = fake_proxy_keeping_fds(dir.path().join("run/proxy.sock"));
        wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
        let sbx = SandboxId("sbx_1".into());
        fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
        assert!(is_ok(&fleet.result("cmd_create").await), "create");
        fleet.commands.send(vec![cmd("cmd_suspend", CommandBody::SandboxSuspend { sandbox: sbx.clone(), epoch: Epoch(1), mode: SuspendMode::DiskOnly })]).unwrap();
        assert!(is_ok(&fleet.result("cmd_suspend").await), "suspend");
        fleet.commands.send(vec![attach_cmd("cmd_attach_1", "sbx_1", "agt_w")]).unwrap();
        assert!(!is_ok(&fleet.result("cmd_attach_1").await), "no guest: the attach fails");
        fleet.commands.send(vec![cmd("cmd_resume", CommandBody::SandboxResume { sandbox: sbx, epoch: Epoch(1) })]).unwrap();
        assert!(is_ok(&fleet.result("cmd_resume").await), "resume");
        fleet.commands.send(vec![attach_cmd("cmd_attach_2", "sbx_1", "agt_w")]).unwrap();
        let r = fleet.result("cmd_attach_2").await;
        assert!(is_ok(&r), "attach after resume: {r:?}");
    });
}
