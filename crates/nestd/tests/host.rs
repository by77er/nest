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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// While `held` is set, the next VM `resume` waits for `release` (after setting `reached`).
#[derive(Default)]
struct ResumeLatch {
    held: AtomicBool,
    reached: AtomicBool,
    release: tokio::sync::Notify,
}

#[derive(Default)]
struct FakeDriver {
    seen: Seen,
    latch: Option<Arc<AttachLatch>>,
    /// The next VM start fails (a create that fails, to be retried at the same epoch).
    fail_next_start: Arc<AtomicBool>,
    /// The next VM starts, but its guest agent never comes up.
    mute_next_guest: Arc<AtomicBool>,
    /// Sandboxes whose VM was stopped, in order.
    stopped: Arc<Mutex<Vec<String>>>,
    /// Lock-free pauses, as (sandbox, epoch).
    paused: Arc<Mutex<Vec<(String, u64)>>>,
    /// VMs started and not yet stopped.
    live: Arc<AtomicUsize>,
    resume_latch: Arc<ResumeLatch>,
}

#[async_trait]
impl Driver for FakeDriver {
    fn name(&self) -> &'static str {
        "fake"
    }
    async fn create(&self, spec: VmSpec) -> std::io::Result<Box<dyn Vm>> {
        std::fs::create_dir_all(&spec.vm_dir)?;
        // Never gets to a VM (the test kills the process meanwhile).
        if spec.sandbox.0.starts_with("sbx_hang") {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
        Ok(Box::new(FakeVm {
            paused: self.paused.clone(),
            spec,
            seen: self.seen.clone(),
            latch: self.latch.clone(),
            fail_next_start: self.fail_next_start.clone(),
            mute_next_guest: self.mute_next_guest.clone(),
            stopped: self.stopped.clone(),
            live: self.live.clone(),
            resume_latch: self.resume_latch.clone(),
            running: false,
            emu: None,
            guest: None,
        }))
    }
}

struct FakeVm {
    paused: Arc<Mutex<Vec<(String, u64)>>>,
    spec: VmSpec,
    seen: Seen,
    latch: Option<Arc<AttachLatch>>,
    fail_next_start: Arc<AtomicBool>,
    mute_next_guest: Arc<AtomicBool>,
    stopped: Arc<Mutex<Vec<String>>>,
    live: Arc<AtomicUsize>,
    resume_latch: Arc<ResumeLatch>,
    running: bool,
    emu: Option<Emulator>,
    guest: Option<tokio::task::JoinHandle<()>>,
}

struct FakePauser(Arc<Mutex<Vec<(String, u64)>>>, String, u64);

#[async_trait]
impl nestd::driver::Pauser for FakePauser {
    async fn pause(&self) -> std::io::Result<()> {
        self.0.lock().unwrap().push((self.1.clone(), self.2));
        Ok(())
    }
}

#[async_trait]
impl Vm for FakeVm {
    fn pauser(&self) -> Option<Arc<dyn nestd::driver::Pauser>> {
        Some(Arc::new(FakePauser(self.paused.clone(), self.spec.sandbox.0.clone(), self.spec.epoch.0)))
    }
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
        self.running = true;
        self.live.fetch_add(1, Ordering::SeqCst);
        if !self.mute_next_guest.swap(false, Ordering::SeqCst) {
            self.guest = Some(fake_guest(&gdir, self.seen.clone(), self.latch.clone()));
        }
        self.emu = Some(Emulator::start(&self.vsock_uds_path(), &gdir)?);
        Ok(())
    }
    async fn pause(&mut self) -> std::io::Result<()> {
        Ok(())
    }
    async fn resume(&mut self) -> std::io::Result<()> {
        if self.resume_latch.held.load(Ordering::SeqCst) {
            let released = self.resume_latch.release.notified();
            self.resume_latch.reached.store(true, Ordering::SeqCst);
            released.await;
        }
        Ok(())
    }
    async fn stop(&mut self) -> std::io::Result<()> {
        self.stopped.lock().unwrap().push(self.spec.sandbox.0.clone());
        if std::mem::take(&mut self.running) {
            self.live.fetch_sub(1, Ordering::SeqCst);
        }
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
    /// Event batches failed by `fail_next_events` (not logged in `events`, not acked).
    failed: Vec<Vec<HostEvent>>,
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
    /// Answer new salvage requests `rejected` with this reason (`parent_mismatch`: transient;
    /// `stale_epoch`: SandboxDO's final word).
    reject_salvage: Arc<Mutex<Option<String>>>,
    /// Answer new salvage requests `committed` (the host still held that epoch), not `orphaned`.
    commit_salvage: Arc<AtomicBool>,
    /// Answer the next new request of any reason `rejected` with this reason.
    reject_next: Arc<Mutex<Option<String>>>,
}

const LEASE: LeaseTiming = LeaseTiming { heartbeat_ms: 50, host_fence_ms: 500, cp_expiry_ms: 800 };

/// Mock FleetDO. Accepts reconnects. While `partition` is set it answers nothing on the open
/// connection and refuses new ones (a network partition); clearing it lets the host reconnect.
/// Like FleetDO, it keeps each command batch until the host acks it and, after each hello_ack,
/// resends those past the hello's `last_command_seq`: a batch sent on a connection the host was
/// already dropping (after a retryable error) is not lost.
async fn mock_fleet() -> MockFleet {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/fleet", l.local_addr().unwrap());
    let log = Arc::new(Mutex::new(FleetLog::default()));
    let partition = Arc::new(AtomicBool::new(false));
    let fail_next_events = Arc::new(AtomicBool::new(false));
    let lose_commit_answers = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (reject_salvage, commit_salvage) = (Arc::new(Mutex::new(None::<String>)), Arc::new(AtomicBool::new(false)));
    let reject_next = Arc::new(Mutex::new(None::<String>));
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<Command>>();
    let (ftx, mut frx) = mpsc::unbounded_channel::<FleetToHost>();
    let (log2, part, fail, lose) = (log.clone(), partition.clone(), fail_next_events.clone(), lose_commit_answers.clone());
    let (reject, commit_s, reject_n) = (reject_salvage.clone(), commit_salvage.clone(), reject_next.clone());
    tokio::spawn(async move {
        let mut seq = 0u64;
        // Command batches sent and not yet acked by the host, by seq.
        let mut unacked: BTreeMap<u64, Vec<Command>> = BTreeMap::new();
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
                        unacked.insert(seq, cmds.clone());
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
                                if let Some(done) = h.last_command_seq {
                                    unacked.retain(|s, _| *s > done.0);
                                }
                                log2.lock().unwrap().hellos.push(*h);
                                let ack = HelloAck { protocol_version: 1, server_ms: 0, last_event_seq: last_event_seq.map(Seq), lease: LEASE, host_token_expires_ms: 0, next_command_seq: None };
                                if ws.send(send(FleetToHost::HelloAck(ack))).await.is_err() { break; }
                                for (s, cmds) in &unacked {
                                    let _ = ws.send(send(FleetToHost::Commands { seq: Seq(*s), commands: cmds.clone() })).await;
                                }
                            }
                            HostToFleet::Heartbeat { sent_ms, leases } => {
                                log2.lock().unwrap().claims.push(leases);
                                let _ = ws.send(send(FleetToHost::HeartbeatAck { sent_ms, server_ms: 0, revoked: vec![] })).await;
                            }
                            HostToFleet::Events { seq: es, events } => {
                                if fail.swap(false, Ordering::SeqCst) {
                                    log2.lock().unwrap().failed.push(events);
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
                                            let rejection = reject.lock().unwrap().clone();
                                            if let Some(why) = reject_n.lock().unwrap().take() {
                                                CommitOutcome::Rejected { reason: why, head: heads.get(sandbox).cloned() }
                                            } else if let (CommitReason::Salvage, Some(why)) = (reason, rejection) {
                                                CommitOutcome::Rejected { reason: why, head: heads.get(sandbox).cloned() }
                                            } else if *reason == CommitReason::Salvage && commit_s.load(Ordering::SeqCst) {
                                                heads.insert(sandbox.clone(), generation.id.clone());
                                                CommitOutcome::Committed { generation }
                                            } else if *reason == CommitReason::Salvage {
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
                                    unacked.insert(seq, answers.clone());
                                    let _ = ws.send(send(FleetToHost::Commands { seq: Seq(seq), commands: answers })).await;
                                }
                            }
                            HostToFleet::Ack { up_to } => {
                                unacked.retain(|s, _| *s > up_to.0);
                                log2.lock().unwrap().acks.push(up_to.0);
                            }
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
    MockFleet { url, log, commands: tx, frames: ftx, partition, fail_next_events, lose_commit_answers, reject_salvage, commit_salvage, reject_next }
}

impl MockFleet {
    /// Wait until `pred` matches some logged event; returns it.
    async fn wait_event(&self, what: &str, pred: impl Fn(&HostEventBody) -> bool) -> HostEventBody {
        let deadline = std::time::Instant::now() + WAIT;
        while std::time::Instant::now() < deadline {
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

/// How long `wait_until` and `MockFleet::wait_event` poll before failing. Wall-clock, not a count
/// of polls (whose sleeps overrun on a loaded machine), and generous: some waits span a retry
/// backoff (a salvage retried after 1 s; a reconnect after nestd's first 200 ms backoff), and CI
/// runs this binary's tests in parallel on a loaded runner.
const WAIT: Duration = Duration::from_secs(15);

/// Polls `f` until it holds, for at most [`WAIT`].
async fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + WAIT;
    while std::time::Instant::now() < deadline {
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
        "role": "sandbox",
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
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: seen.clone(), ..Default::default() }))).await.unwrap();
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

    // 2. Start a worker: the runner gets the sandbox's id and its agent epoch, never a socket path.
    let start = AgentStart {
        agent: AgentId("agt_w".into()),
        role: None,
        workstream: WorkstreamId("ws_1".into()),
        epoch: Some(Epoch(1)),
        resume: None,
        hands: Some(HandsBinding { sandbox: sbx.clone(), epoch: None }),
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

    // The guest writes after the checkpoint: work the commit doesn't cover (salvage, below, skips
    // a disk that still matches its head).
    let mut disk = std::fs::OpenOptions::new().append(true).open(dir.path().join("state/sandboxes/sbx_1/1/disk.img")).unwrap();
    std::io::Write::write_all(&mut disk, b"after the checkpoint").unwrap();
    drop(disk);

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
    // The disk changed after the checkpoint: salvage is offered.
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
        FakeDriver::default().create(spec).await
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
            "role": "sandbox", "cell": "c",
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
        let deadline = std::time::Instant::now() + WAIT;
        while received.lock().unwrap().len() != 5 && std::time::Instant::now() < deadline {
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
    /// Set it to make the next VM start fail.
    fail_next_start: Arc<AtomicBool>,
    /// Set it to make the next VM start without a guest agent.
    mute_next_guest: Arc<AtomicBool>,
    /// Lock-free pauses, as (sandbox, epoch).
    paused: Arc<Mutex<Vec<(String, u64)>>>,
    /// VMs started and not yet stopped.
    live: Arc<AtomicUsize>,
    resume_latch: Arc<ResumeLatch>,
}

/// How long the harness's nestd waits for a guest agent to come up (the fake guest is in-process).
const GUEST_READY_TIMEOUT_MS: u64 = 3000;

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
        "role": "sandbox", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": commit_timeout_ms,
        "guest_ready_timeout_ms": GUEST_READY_TIMEOUT_MS,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca, tunnel_token: None, gateway_url: None };
    let driver = FakeDriver::default();
    let (seen, stopped, fail_next_start, mute_next_guest, paused, live, resume_latch) = (
        driver.seen.clone(),
        driver.stopped.clone(),
        driver.fail_next_start.clone(),
        driver.mute_next_guest.clone(),
        driver.paused.clone(),
        driver.live.clone(),
        driver.resume_latch.clone(),
    );
    let host = Host::start(cfg, enrolled, Some(Arc::new(driver))).await.unwrap();
    let runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    let proxy = fake_proxy(dir.path().join("run/proxy.sock"));
    let gateway = fake_gateway(&dir.path().join("run/gateway.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    Started { _host: host, dir, fleet, _runner: runner, proxy, gateway, seen, stopped, fail_next_start, mute_next_guest, paused, live, resume_latch }
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
        "role": "sandbox", "cell": "test-cell",
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
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let (metrics, ready) = fake_metrics().await;
    let log = dir.path().join("cloudflared.log");
    let bin = dir.path().join("cloudflared");
    install_executable(&bin, format!("#!/bin/sh\necho pid=$$ >> {l}\nwhile [ $# -gt 0 ]; do [ \"$1\" = --metrics ] && echo metrics=$2 >> {l}; shift; done\ntrap 'echo term >> {l}; exit 0' TERM\nwhile :; do sleep 0.1; done\n", l = log.display()));
    // The configured user: the test's own, the only one an unprivileged test can switch to.
    let me = nix::unistd::User::from_uid(nix::unistd::getuid()).unwrap().unwrap().name;
    let cfg = tunnel_config_with_metrics(dir.path(), &fleet.url, &bin, Some(me), &metrics);
    let host = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver::default()))).await.unwrap();
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
    let host = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver::default()))).await.unwrap();
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
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let log = dir.path().join("cloudflared.log");
    let bin = dir.path().join("cloudflared");
    install_executable(&bin, format!("#!/bin/sh\necho pid=$$ >> {}\nexit 0\n", log.display()));
    let mut cfg = tunnel_config(dir.path(), &fleet.url, &bin, None);
    cfg.run_dir = "/proc/no-such-dir/run".into();
    let err = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver::default()))).await.err().unwrap();
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
    let err = Host::start(cfg, tunnel_enrolled(&fleet.url), Some(Arc::new(FakeDriver::default()))).await.err().unwrap();
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
        "role": "sandbox", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": 5000,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let latch = Arc::new(AttachLatch::default());
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { seen: seen.clone(), latch: Some(latch.clone()), ..Default::default() }))).await.unwrap();
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
        "role": "sandbox", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": 5000,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let fail = Arc::new(AtomicBool::new(true));
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver { fail_next_start: fail.clone(), ..Default::default() }))).await.unwrap();
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
    // The startup capacity report goes first, so the batch failed below is cmd_a's.
    h.fleet.wait_event("startup capacity", |b| matches!(b, HostEventBody::Capacity { .. })).await;
    h.fleet.fail_next_events.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    // The batch carrying cmd_a's events failed once; it still arrives, exactly once.
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    wait_until("reconnect", || h.fleet.log.lock().unwrap().hellos.len() >= 2).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let log = h.fleet.log.lock().unwrap();
    let [failed] = log.failed.as_slice() else { panic!("one failed batch: {:#?}", log.failed) };
    let about_a = |b: &HostEventBody| matches!(b, HostEventBody::CommandResult { cmd, .. } if cmd.0 == "cmd_a") || matches!(b, HostEventBody::SandboxState { sandbox, .. } if sandbox.0 == "sbx_a");
    assert!(failed.iter().any(|e| about_a(&e.body)), "the failed batch carried cmd_a's events: {failed:#?}");
    for e in failed {
        let (sent, logged) = (failed.iter().filter(|f| *f == e).count(), log.events.iter().filter(|f| *f == e).count());
        assert_eq!(logged, sent, "resent exactly once: {e:#?}");
    }
    let n = log.events.iter().filter(|e| matches!(&e.body, HostEventBody::CommandResult { cmd, .. } if cmd.0 == "cmd_a")).count();
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

/// Review #17, revised for per-incarnation directories: a newer-epoch create of a sandbox that
/// still has uncommitted work here doesn't wait for it: the old incarnation is salvaged (sibling
/// branch) in the background from its own directory, then deleted, and the new one's is untouched.
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
    h.fleet.wait_event("old epoch's work salvaged", |b| matches!(b, HostEventBody::CommitRequest { reason: CommitReason::Salvage, epoch: Epoch(1), .. })).await;
    let state = h.dir.path().join("state/sandboxes/sbx_m");
    wait_until("the old incarnation deleted", || !state.join("1").exists()).await;
    assert!(state.join("2/disk.img").exists() && state.join("2/meta.json").exists(), "the new incarnation's directory");
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
/// only the disk, which salvage reads; once the salvage lands the disk goes too, and nestd says so
/// (`fenced` with `dirty: false`, so FleetDO doesn't wait out the salvage window). The clean
/// `fenced` row stays in every hello until `sandbox_destroy` at that (old) epoch removes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fence_stops_the_vm_and_a_destroy_at_the_old_epoch_reaps_it() {
    let h = start_host().await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    let disk = h.dir.path().join("state/sandboxes/sbx_1/1/disk.img");
    assert!(disk.exists());

    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![sbx.clone()], reason: "test".into() })]).unwrap();
    h.fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    wait_until("the fenced VM is stopped", || h.stopped.lock().unwrap().contains(&"sbx_1".to_string())).await;
    h.fleet.wait_event("salvage", |b| matches!(b, HostEventBody::CommitRequest { reason: CommitReason::Salvage, .. })).await;
    h.fleet.wait_event("reported clean", |b| matches!(b, HostEventBody::IncarnationRetired { epoch: Epoch(1), .. })).await;
    assert!(!disk.parent().unwrap().exists(), "the salvaged incarnation's directory is gone");

    // The row stays, clean, until the destroy.
    let reconnect = |id: &str| {
        let n = h.fleet.log.lock().unwrap().hellos.len();
        h.fleet.fail_next_events.store(true, Ordering::SeqCst);
        h.fleet.commands.send(vec![cmd(id, CommandBody::PortUnexpose { sandbox: SandboxId("sbx_none".into()), epoch: Epoch(1), port: 1 })]).unwrap();
        n
    };
    let n = reconnect("cmd_poke");
    wait_until("reconnect", || h.fleet.log.lock().unwrap().hellos.len() > n).await;
    let hello = h.fleet.log.lock().unwrap().hellos.last().cloned().unwrap();
    assert!(matches!(hello.sandboxes.as_slice(), [r] if r.state == SandboxState::Fenced && !r.dirty), "{:?}", hello.sandboxes);

    h.fleet.commands.send(vec![cmd("cmd_destroy", CommandBody::SandboxDestroy { sandbox: sbx.clone(), epoch: Epoch(1) })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_destroy").await));
    let n = reconnect("cmd_poke_2");
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
        "role": "sandbox", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let _host = Host::start(cfg, enrolled, Some(Arc::new(FakeDriver::default()))).await.unwrap();
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
        role: None,
        workstream: WorkstreamId("ws_1".into()),
        epoch: Some(Epoch(1)),
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
    let started = RunnerEvent::AgentStarted { agent: AgentId("agt_c".into()), pid: 9, session: SessionId("ses_1".into()), claude_version: "t".into(), capabilities: vec![], epoch: Some(Epoch(1)) };
    r.send(bytes::Bytes::from(serde_json::to_vec(&started).unwrap())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    drop(r);
    // nestd reports it itself (the runner is gone), with the agent epoch of its start here.
    fleet.wait_event("the lost brain reported", |b| matches!(b, HostEventBody::AgentExited { agent, reason, epoch, .. } if agent.0 == "agt_c" && *reason == AgentExitReason::Crashed && *epoch == Some(Epoch(1)))).await;
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

fn suspend_cmd(id: &str, sandbox: &str, mode: SuspendMode) -> Command {
    cmd(id, CommandBody::SandboxSuspend { sandbox: SandboxId(sandbox.into()), epoch: Epoch(1), mode })
}

fn resume_cmd(id: &str, sandbox: &str) -> Command {
    cmd(id, CommandBody::SandboxResume { sandbox: SandboxId(sandbox.into()), epoch: Epoch(1) })
}

/// A cold resume whose guest never comes up fails, and stops the VM it started: no VM is left
/// running under `suspended`, and the next resume boots the only VM on the disk. It used to keep
/// running, and the next resume started a second VM on the same disk.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_cold_resume_stops_its_vm() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1"), suspend_cmd("cmd_suspend", "sbx_1", SuspendMode::DiskOnly)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_suspend").await));
    assert_eq!(h.live.load(Ordering::SeqCst), 0, "a disk-only suspend stops the VM");

    h.mute_next_guest.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![resume_cmd("cmd_resume_1", "sbx_1")]).unwrap();
    // Outlasts the guest-ready timeout (GUEST_READY_TIMEOUT_MS): fleet.result waits WAIT.
    assert!(!is_ok(&h.fleet.result("cmd_resume_1").await), "no guest: the resume fails");
    assert_eq!(h.live.load(Ordering::SeqCst), 0, "the failed resume's VM was stopped");

    h.fleet.commands.send(vec![resume_cmd("cmd_resume_2", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_resume_2").await));
    assert_eq!(h.live.load(Ordering::SeqCst), 1, "one VM on the disk");
}

/// The last state `sandbox` reported.
fn last_state(fleet: &MockFleet, sandbox: &str) -> Option<SandboxState> {
    fleet.log.lock().unwrap().events.iter().rev().find_map(|e| match &e.body {
        HostEventBody::SandboxState { sandbox: s, state, .. } if s.0 == sandbox => Some(*state),
        _ => None,
    })
}

/// A suspend whose commit fails (here its answer is lost: a timeout) rolls back: the VM runs on and
/// the sandbox reports `running` again, so SandboxDO's idle timer can ask again. It used to stay
/// `suspending` with a paused VM, which nothing resumes (a wake resumes only `suspended`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_suspend_rolls_back_to_running() {
    let h = start_host_opts(None, 400).await;
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    h.fleet.commands.send(vec![suspend_cmd("cmd_suspend_1", "sbx_1", SuspendMode::DiskOnly)]).unwrap();
    assert!(!is_ok(&h.fleet.result("cmd_suspend_1").await), "the commit times out (commit_timeout_ms 400)");
    wait_until("running again", || last_state(&h.fleet, "sbx_1") == Some(SandboxState::Running)).await;
    assert_eq!(h.live.load(Ordering::SeqCst), 1, "the VM runs on");

    // Asked again, the suspend lands (adopting the lost commit's outcome).
    h.fleet.commands.send(vec![suspend_cmd("cmd_suspend_2", "sbx_1", SuspendMode::DiskOnly)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_suspend_2").await));
    assert_eq!(last_state(&h.fleet, "sbx_1"), Some(SandboxState::Suspended));
}

/// A drain whose deadline passes while a suspend waits for its commit's answer gives the suspend
/// that much time, never cancels it: the request is kept as unanswered, so the next commit asks
/// again under its id. Cancelled, the record was lost, and the next commit's stale parent was
/// rejected `parent_mismatch`, which fences the sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drain_past_its_deadline_keeps_the_unanswered_commit() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    // The deadline (500 ms) comes well before the commit timeout (5 s).
    let drain = CommandBody::Drain { reason: "test".into(), deadline_ms: nestd_now_ms() + 500 };
    h.fleet.commands.send(vec![cmd("cmd_drain", drain)]).unwrap();
    assert!(!is_ok(&h.fleet.result("cmd_drain").await), "not drained");
    let generation = checkpoint(&h.fleet, "cmd_ck", "sbx_1", 1).await;
    let requests: Vec<RequestId> =
        h.fleet.log.lock().unwrap().events.iter().filter_map(|e| match &e.body { HostEventBody::CommitRequest { request, .. } => Some(request.clone()), _ => None }).collect();
    assert_eq!(generation.0, format!("gen_{}", requests[0].0), "the lost suspend commit's outcome is adopted: {requests:?}");
    assert_eq!(last_state(&h.fleet, "sbx_1"), Some(SandboxState::Running));
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
            "role": "sandbox", "cell": "c",
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

// ---------------------------------------------------------------------------------------------
// After a nestd restart (nestd review #7), retiring incarnations, and the tombstones (#12)
// ---------------------------------------------------------------------------------------------

fn harness_config(dir: &Path, fleet_url: &str, commit_timeout_ms: u64) -> Config {
    serde_json::from_value(serde_json::json!({
        "role": "sandbox", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet_url},
        "run_dir": dir.join("run"), "state_dir": dir.join("state"),
        "driver": {"type": "process", "guest_command": ["unused"]},
        "network": {"type": "none"}, "flush_interval_ms": 20, "commit_timeout_ms": commit_timeout_ms,
    }))
    .unwrap()
}

fn harness_enrolled(fleet_url: &str) -> Enrolled {
    Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet_url.into(), proxy_ca: None, tunnel_token: None, gateway_url: None }
}

/// One nestd process on `dir` against `fleet`, with its fake peers, after its first hello.
/// `driver: None` runs the process driver from the config.
struct Proc {
    host: Host,
    fleet: MockFleet,
    _runner: Arc<Mutex<Vec<RunnerCommand>>>,
    _proxy: Arc<Mutex<Vec<ProxyCommand>>>,
    _gw: FakeGateway,
}

async fn nestd_process(dir: &Path, fleet: MockFleet, commit_timeout_ms: u64, driver: Option<Arc<dyn Driver>>) -> Proc {
    let host = Host::start(harness_config(dir, &fleet.url, commit_timeout_ms), harness_enrolled(&fleet.url), driver).await.unwrap();
    let _runner = fake_runner(&dir.join("run/runner.sock")).await;
    let _proxy = fake_proxy(dir.join("run/proxy.sock"));
    let _gw = fake_gateway(&dir.join("run/gateway.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    Proc { host, fleet, _runner, _proxy, _gw }
}

fn fake_driver() -> Arc<dyn Driver> {
    Arc::new(FakeDriver::default())
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

fn sandbox_meta(dir: &Path, sandbox: &str, epoch: u64) -> nestd::recovery::SandboxMeta {
    nestd::recovery::read_meta(&dir.join("state/sandboxes").join(sandbox).join(epoch.to_string())).expect("meta.json")
}

fn append_to_disk(dir: &Path, sandbox: &str, epoch: u64, what: &[u8]) {
    let path = dir.join("state/sandboxes").join(sandbox).join(epoch.to_string()).join("disk.img");
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    std::io::Write::write_all(&mut f, what).unwrap();
}

fn create_at(id: &str, sandbox: &str, epoch: u64) -> Command {
    let mut c = create(id, sandbox);
    if let CommandBody::SandboxCreate { epoch: e, .. } = &mut c.body {
        *e = Epoch(epoch);
    }
    c
}

fn error_code(o: &CommandOutcome) -> Option<(String, bool)> {
    match o {
        CommandOutcome::Error { error } => Some((error.code.clone(), error.retryable)),
        CommandOutcome::Ok { .. } => None,
    }
}

/// Every salvage `commit_request` for `sandbox@epoch` logged so far: its request id, in order.
fn salvage_requests(fleet: &MockFleet, sandbox: &str, epoch: u64) -> Vec<RequestId> {
    fleet
        .log
        .lock()
        .unwrap()
        .events
        .iter()
        .filter_map(|e| match &e.body {
            HostEventBody::CommitRequest { request, sandbox: s, epoch: ep, reason: CommitReason::Salvage, .. } if s.0 == sandbox && ep.0 == epoch => Some(request.clone()),
            _ => None,
        })
        .collect()
}

fn distinct(ids: &[RequestId]) -> usize {
    ids.iter().collect::<std::collections::BTreeSet<_>>().len()
}

async fn checkpoint(fleet: &MockFleet, id: &str, sandbox: &str, epoch: u64) -> GenerationId {
    fleet.commands.send(vec![cmd(id, CommandBody::SandboxCheckpoint { sandbox: SandboxId(sandbox.into()), epoch: Epoch(epoch), reason: CommitReason::TurnEnd })]).unwrap();
    match fleet.result(id).await {
        CommandOutcome::Ok { detail: Some(d) } => GenerationId(d["generation"].as_str().unwrap().into()),
        other => panic!("checkpoint: {other:?}"),
    }
}

/// Make the fleet connection drop and come back (a failed events batch), and return the next hello.
async fn next_hello(fleet: &MockFleet, poke: &str) -> HostHello {
    let n = fleet.log.lock().unwrap().hellos.len();
    fleet.fail_next_events.store(true, Ordering::SeqCst);
    fleet.commands.send(vec![cmd(poke, CommandBody::PortUnexpose { sandbox: SandboxId("sbx_none".into()), epoch: Epoch(1), port: 1 })]).unwrap();
    wait_until("reconnect", || fleet.log.lock().unwrap().hellos.len() > n).await;
    fleet.log.lock().unwrap().hellos.last().cloned().unwrap()
}

/// nestd review #7 (and the review of its fix: M1, L2). Three nestd processes on one state
/// directory, each dying with its runtime (every task and VM with it):
///
/// 1. The first leaves three sandboxes: one suspended (its `meta.json` says the disk equals its
///    head; resume clears that, the next suspend sets it again), one written to after its last
///    commit, and one unchanged since a commit whose head carries memory (as after a memory
///    suspend that was resumed).
/// 2. The second deletes the suspended one, and one whose create died before its VM started,
///    without reporting them (FleetDO evicts or re-places them, as before), and removes a directory
///    without `meta.json` and an older nestd's flat layout, all before its first hello. That hello reports the other two `fenced`. The unchanged one has
///    nothing to salvage (its head's memory doesn't matter) and is deleted and reported clean; the
///    changed one's salvage request is sent, its answer lost, and the process dies waiting.
/// 3. The third asks again under the same request id (from `meta.json`), deletes it once
///    answered, reports it clean, and keeps the epoch tombstoned until a destroy.
///
/// Evidence: the nestd harness. The first process boots the fake guest behind the vsock emulator;
/// the others run the process driver from their config and boot nothing. No VM, no Firecracker.
#[test]
fn a_restarted_nestd_reports_salvages_and_deletes_what_it_left() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state/sandboxes");

    let rt1 = runtime();
    let heads: BTreeMap<String, GenerationId> = rt1.block_on(async {
        let p = nestd_process(dir.path(), mock_fleet().await, 5000, Some(fake_driver())).await;
        let f = &p.fleet;
        let suspend = |id: &str| cmd(id, CommandBody::SandboxSuspend { sandbox: SandboxId("sbx_clean".into()), epoch: Epoch(1), mode: SuspendMode::DiskOnly });
        f.commands.send(vec![create("cmd_c_clean", "sbx_clean")]).unwrap();
        assert!(is_ok(&f.result("cmd_c_clean").await));
        assert!(!sandbox_meta(dir.path(), "sbx_clean", 1).clean, "a running disk is never clean");
        f.commands.send(vec![suspend("cmd_s1")]).unwrap();
        assert!(is_ok(&f.result("cmd_s1").await));
        assert!(sandbox_meta(dir.path(), "sbx_clean", 1).clean, "suspended: the disk equals its head");
        f.commands.send(vec![cmd("cmd_r1", CommandBody::SandboxResume { sandbox: SandboxId("sbx_clean".into()), epoch: Epoch(1) })]).unwrap();
        assert!(is_ok(&f.result("cmd_r1").await));
        assert!(!sandbox_meta(dir.path(), "sbx_clean", 1).clean, "resumed: a VM writes to the disk again");
        f.commands.send(vec![suspend("cmd_s2")]).unwrap();
        assert!(is_ok(&f.result("cmd_s2").await));
        assert!(sandbox_meta(dir.path(), "sbx_clean", 1).clean);

        let mut heads = BTreeMap::new();
        for sbx in ["sbx_dirty", "sbx_memhead"] {
            f.commands.send(vec![create(&format!("cmd_c_{sbx}"), sbx)]).unwrap();
            assert!(is_ok(&f.result(&format!("cmd_c_{sbx}")).await));
            let m = sandbox_meta(dir.path(), sbx, 1);
            assert_eq!((m.version, m.epoch, m.head.is_none()), (nestd::recovery::META_VERSION, Epoch(1), true), "meta.json once the disk is ready");
            let g = checkpoint(f, &format!("cmd_k_{sbx}"), sbx, 1).await;
            assert_eq!(sandbox_meta(dir.path(), sbx, 1).head.map(|h| h.id), Some(g.clone()), "meta.json follows the head");
            heads.insert(sbx.to_string(), g);
        }
        append_to_disk(dir.path(), "sbx_dirty", 1, b"uncommitted work");
        // A create that dies before its VM starts: the disk is still the untouched base.
        f.commands.send(vec![create("cmd_c_hang", "sbx_hang")]).unwrap();
        wait_until("the hanging create's disk", || state.join("sbx_hang/1/meta.json").exists()).await;
        assert!(sandbox_meta(dir.path(), "sbx_hang", 1).clean, "no VM has run on it");
        let inc = state.join("sbx_memhead/1");
        let mut m = nestd::recovery::read_meta(&inc).unwrap();
        let head = m.head.as_mut().unwrap();
        head.kind = GenerationKind::Checkpoint;
        head.mem_manifest = Some(ManifestHash(format!("blake3:{}", "2".repeat(64))));
        nestd::recovery::write_meta(&inc, &m).unwrap();
        drop(p);
        heads
    });
    rt1.shutdown_timeout(Duration::from_secs(2)); // the process is gone
    assert!(dir.path().join("run/vm/sbx_dirty/1").exists(), "the dead process's VM runtime directory");
    std::fs::create_dir_all(state.join("sbx_junk/1")).unwrap();
    std::fs::write(state.join("sbx_junk/1/disk.img"), b"half restored").unwrap();
    std::fs::create_dir_all(state.join("sbx_flat")).unwrap();
    std::fs::write(state.join("sbx_flat/disk.img"), b"an older nestd's").unwrap();

    let rt2 = runtime();
    let lost: RequestId = rt2.block_on(async {
        let fleet = mock_fleet().await;
        fleet.lose_commit_answers.store(1, Ordering::SeqCst);
        let p = nestd_process(dir.path(), fleet, 5000, None).await;
        for gone in ["sbx_clean", "sbx_hang", "sbx_junk", "sbx_flat"] {
            assert!(!state.join(gone).exists(), "{gone} is still there after start");
        }
        assert!(!dir.path().join("run/vm/sbx_dirty").exists(), "VM runtime directories are swept at start");
        let hello = p.fleet.log.lock().unwrap().hellos[0].clone();
        let reported: Vec<(String, Epoch, SandboxState, Option<GenerationId>)> = hello.sandboxes.iter().map(|s| (s.sandbox.0.clone(), s.epoch, s.state, s.head.clone())).collect();
        assert_eq!(
            reported,
            vec![
                ("sbx_dirty".into(), Epoch(1), SandboxState::Fenced, Some(heads["sbx_dirty"].clone())),
                ("sbx_memhead".into(), Epoch(1), SandboxState::Fenced, Some(heads["sbx_memhead"].clone())),
            ],
            "the first hello reports the incarnations with possible work as fenced, and nothing else"
        );
        assert!(hello.sandboxes[0].dirty);

        p.fleet.wait_event("the unchanged one reported clean", |b| matches!(b, HostEventBody::IncarnationRetired { sandbox, .. } if sandbox.0 == "sbx_memhead")).await;
        assert!(!state.join("sbx_memhead").exists());
        assert!(salvage_requests(&p.fleet, "sbx_memhead", 1).is_empty(), "a disk equal to its head's has nothing to salvage");
        wait_until("the changed one's salvage", || !salvage_requests(&p.fleet, "sbx_dirty", 1).is_empty()).await;
        let sent = salvage_requests(&p.fleet, "sbx_dirty", 1)[0].clone();
        let HostEventBody::CommitRequest { parent, .. } = p.fleet.wait_event("salvage", |b| matches!(b, HostEventBody::CommitRequest { .. })).await else { unreachable!() };
        assert_eq!(parent, Some(heads["sbx_dirty"].clone()), "a sibling of the head meta.json names");
        assert_eq!(sandbox_meta(dir.path(), "sbx_dirty", 1).unanswered.map(|u| u.request), Some(sent.clone()), "the request is on disk before its answer");
        let claimed = p.fleet.log.lock().unwrap().claims.iter().flatten().any(|c| c.sandbox.0.starts_with("sbx_"));
        assert!(!claimed, "a heartbeat claimed a lease for a dead incarnation");
        drop(p);
        sent
    });
    rt2.shutdown_timeout(Duration::from_secs(2));
    assert!(state.join("sbx_dirty/1/disk.img").exists(), "an unanswered salvage keeps the disk");

    let rt3 = runtime();
    rt3.block_on(async {
        let p = nestd_process(dir.path(), mock_fleet().await, 5000, None).await;
        wait_until("the salvage asked again", || !salvage_requests(&p.fleet, "sbx_dirty", 1).is_empty()).await;
        assert_eq!(salvage_requests(&p.fleet, "sbx_dirty", 1)[0], lost, "asked again under the request id the last process sent");
        p.fleet.wait_event("reported clean", |b| matches!(b, HostEventBody::IncarnationRetired { sandbox, .. } if sandbox.0 == "sbx_dirty")).await;
        assert!(!state.join("sbx_dirty").exists());

        // The epoch is over here: a create at it is final, not retried.
        let sbx = SandboxId("sbx_dirty".into());
        assert_eq!(p.host.inner.fenced_epoch(&sbx), Some(Epoch(1)));
        p.fleet.commands.send(vec![create("cmd_again", "sbx_dirty")]).unwrap();
        assert_eq!(error_code(&p.fleet.result("cmd_again").await), Some(("stale_epoch".into(), false)));
        let hello = next_hello(&p.fleet, "cmd_poke").await;
        assert!(matches!(hello.sandboxes.as_slice(), [r] if r.sandbox == sbx && r.state == SandboxState::Fenced && !r.dirty), "the row stays fenced, now clean: {:?}", hello.sandboxes);
        p.fleet.commands.send(vec![cmd("cmd_destroy", CommandBody::SandboxDestroy { sandbox: sbx.clone(), epoch: Epoch(1) })]).unwrap();
        assert!(is_ok(&p.fleet.result("cmd_destroy").await));
        assert_eq!(p.host.inner.fenced_epoch(&sbx), None, "a destroy at the fenced epoch prunes its tombstone");
        drop(p);
    });
    rt3.shutdown_timeout(Duration::from_secs(2));
}

/// The review of #7's fix (M2, M3): a create at a newer epoch races the salvage of an incarnation a
/// previous nestd left. The create doesn't wait for it (each incarnation has its own directory),
/// and nothing the old incarnation's salvage hears touches the new one: a rejection doesn't fence
/// it, and a salvage that SandboxDO commits doesn't move its row's head. The salvage is retried
/// with backoff while it fails transiently (first answer lost, then `parent_mismatch`) until it
/// lands; then only the old directory goes.
#[test]
fn a_newer_create_races_the_salvage_of_what_a_dead_nestd_left() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state/sandboxes/sbx_x");
    let rt1 = runtime();
    rt1.block_on(async {
        let p = nestd_process(dir.path(), mock_fleet().await, 5000, Some(fake_driver())).await;
        p.fleet.commands.send(vec![create("cmd_c1", "sbx_x")]).unwrap();
        assert!(is_ok(&p.fleet.result("cmd_c1").await));
        append_to_disk(dir.path(), "sbx_x", 1, b"work");
        drop(p);
    });
    rt1.shutdown_timeout(Duration::from_secs(2));

    let rt2 = runtime();
    rt2.block_on(async {
        let fleet = mock_fleet().await;
        fleet.lose_commit_answers.store(1, Ordering::SeqCst);
        *fleet.reject_salvage.lock().unwrap() = Some("parent_mismatch".into());
        // Commit answers time out after 300 ms; retries wait 1 s, then 2 s, 4 s (RETIRE_RETRY_FIRST).
        let p = nestd_process(dir.path(), fleet, 300, Some(fake_driver())).await;
        let f = &p.fleet;
        f.commands.send(vec![create_at("cmd_c2", "sbx_x", 2)]).unwrap();
        assert!(is_ok(&f.result("cmd_c2").await), "the newer epoch doesn't wait for the old one's salvage");
        // Lost, asked again (the stored rejection), then a new request (rejected again).
        wait_until("two salvage requests", || distinct(&salvage_requests(f, "sbx_x", 1)) >= 2).await;
        let first = salvage_requests(f, "sbx_x", 1);
        assert_eq!(first[0], first[1], "a lost answer is asked again under the same id");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let fenced_new = f.log.lock().unwrap().events.iter().any(|e| matches!(e.body, HostEventBody::SandboxState { state: SandboxState::Fenced, epoch: Epoch(2), .. }));
        assert!(!fenced_new, "the old incarnation's rejected salvage fenced the new one");

        *f.reject_salvage.lock().unwrap() = None;
        f.commit_salvage.store(true, Ordering::SeqCst);
        wait_until("the old incarnation deleted", || !state.join("1").exists()).await;
        assert!(state.join("2/disk.img").exists(), "the new incarnation's directory");
        let hello = next_hello(f, "cmd_poke").await;
        assert!(
            matches!(hello.sandboxes.as_slice(), [r] if r.epoch == Epoch(2) && r.state == SandboxState::Running && r.head.is_none() && r.dirty),
            "the old incarnation's salvage changed the new one's row: {:?}",
            hello.sandboxes
        );
        drop(p);
    });
    rt2.shutdown_timeout(Duration::from_secs(2));
}

/// The review of #7's fix (M3): a fenced incarnation's salvage whose answer is lost is retried
/// under the same request id until it lands; then the disk goes and the row is reported clean.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_salvage_is_retried_until_it_lands() {
    let h = start_host_opts(None, 300).await;
    h.fleet.commands.send(vec![create("cmd_c", "sbx_r")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c").await));
    append_to_disk(h.dir.path(), "sbx_r", 1, b"work");
    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    h.fleet.commands.send(vec![cmd("cmd_f", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_r".into())], reason: "test".into() })]).unwrap();
    // The answer times out after 300 ms; the retry follows 1 s later (RETIRE_RETRY_FIRST).
    wait_until("the salvage asked again", || salvage_requests(&h.fleet, "sbx_r", 1).len() >= 2).await;
    let ids = salvage_requests(&h.fleet, "sbx_r", 1);
    assert_eq!(distinct(&ids), 1, "the retry asks under the same id: {ids:?}");
    h.fleet.wait_event("reported clean", |b| matches!(b, HostEventBody::IncarnationRetired { .. })).await;
    assert!(!h.dir.path().join("state/sandboxes/sbx_r").exists());
}

/// A fenced incarnation is retired once: superseded by a newer create while its salvage waits for
/// an answer, it still makes one sibling branch, not two.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fenced_incarnation_is_salvaged_once_even_when_superseded() {
    let h = start_host_opts(None, 300).await;
    h.fleet.commands.send(vec![create("cmd_c1", "sbx_o")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c1").await));
    append_to_disk(h.dir.path(), "sbx_o", 1, b"work");
    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    h.fleet.commands.send(vec![cmd("cmd_f", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_o".into())], reason: "test".into() })]).unwrap();
    wait_until("the fence's salvage", || !salvage_requests(&h.fleet, "sbx_o", 1).is_empty()).await;
    h.fleet.commands.send(vec![create_at("cmd_c2", "sbx_o", 2)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c2").await));
    wait_until("the old incarnation deleted", || !h.dir.path().join("state/sandboxes/sbx_o/1").exists()).await;
    let ids = salvage_requests(&h.fleet, "sbx_o", 1);
    assert_eq!(distinct(&ids), 1, "one salvage per incarnation: {ids:?}");
    assert!(h.dir.path().join("state/sandboxes/sbx_o/2/disk.img").exists());
}

/// nestd review #12: the fenced epoch's tombstone (one map that the proxy and gateway links both
/// consult) lives as long as the fenced incarnation, not forever. A create at that epoch answers
/// `stale_epoch`, final, even after a newer epoch's failed create tore the fenced row down (it
/// used to fail inside the proxy link as a retryable `internal`); a newer epoch that runs prunes
/// it, and a destroy prunes the next one. A failed create leaves no directory behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fenced_epoch_stays_stale_until_a_newer_epoch_runs() {
    let h = start_host().await;
    let sbx = SandboxId("sbx_t".into());
    h.fleet.commands.send(vec![create_at("cmd_c1", "sbx_t", 1)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c1").await));
    h.fleet.commands.send(vec![cmd("cmd_f1", CommandBody::Fence { sandboxes: vec![sbx.clone()], reason: "test".into() })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_f1").await));
    assert_eq!(h._host.inner.fenced_epoch(&sbx), Some(Epoch(1)));

    // A newer epoch's create replaces the fenced row, then fails to boot.
    h.fail_next_start.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![create_at("cmd_c2", "sbx_t", 2)]).unwrap();
    assert_eq!(error_code(&h.fleet.result("cmd_c2").await).map(|(c, _)| c), Some("internal".into()));
    assert!(!h.dir.path().join("state/sandboxes/sbx_t/2").exists(), "a failed create left its directory");
    assert_eq!(h._host.inner.fenced_epoch(&sbx), Some(Epoch(1)), "a newer epoch that never ran prunes nothing");
    h.fleet.commands.send(vec![create_at("cmd_c1_again", "sbx_t", 1)]).unwrap();
    assert_eq!(error_code(&h.fleet.result("cmd_c1_again").await), Some(("stale_epoch".into(), false)), "the fenced epoch is final");

    h.fleet.commands.send(vec![create_at("cmd_c2_again", "sbx_t", 2)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c2_again").await));
    assert_eq!(h._host.inner.fenced_epoch(&sbx), None, "the newer epoch runs: the old tombstone is pruned");

    h.fleet.commands.send(vec![cmd("cmd_f2", CommandBody::Fence { sandboxes: vec![sbx.clone()], reason: "test".into() })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_f2").await));
    assert_eq!(h._host.inner.fenced_epoch(&sbx), Some(Epoch(2)));
    h.fleet.commands.send(vec![cmd("cmd_d2", CommandBody::SandboxDestroy { sandbox: sbx.clone(), epoch: Epoch(2) })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_d2").await));
    assert_eq!(h._host.inner.fenced_epoch(&sbx), None, "a destroy at the fenced epoch prunes it");
}

/// nestd review #7, the network half: a netns bind mount a dead nestd left under `persist_dir`
/// (its tap and nft table inside) is torn down when the next nestd starts, before `Host::start`
/// returns (the fleet client starts after it). Evidence: the harness in a user namespace (a real
/// netns, tap and nft); no VM.
#[test]
fn a_restarted_nestd_tears_down_leftover_netns_mounts() {
    if !nestd::net::reexec_in_userns("a_restarted_nestd_tears_down_leftover_netns_mounts") {
        return;
    }
    let rt = runtime();
    rt.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let persist = dir.path().join("netns");
        let left = persist.join("ns-sbx_left");
        let ns = nestd::net::Netns::create(Some(&left)).unwrap();
        ns.configure(None).unwrap();
        std::mem::forget(ns); // the old process died without unmounting it
        let mounted = || std::fs::read_to_string("/proc/self/mountinfo").unwrap().contains(&left.display().to_string());
        assert!(mounted());
        let fleet = mock_fleet().await;
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "role": "sandbox", "cell": "c",
            "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
            "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"),
            "driver": {"type": "process", "guest_command": ["unused"]},
            "network": {"type": "netns", "persist_dir": persist},
            "flush_interval_ms": 20,
        }))
        .unwrap();
        let _host = Host::start(cfg, harness_enrolled(&fleet.url), Some(Arc::new(NetnsCapture(Arc::new(Mutex::new(None)))))).await.unwrap();
        assert!(!left.exists() && !mounted(), "the leftover netns mount survived the start");
    });
}

/// The review of the fix (M2): a final refusal of a salvage (`stale_epoch`: SandboxDO will never
/// take that work) ends the retire at once: no retry, the disk deleted, `incarnation_retired`.
/// Inventory B1: a retire first asks again under an unanswered request; when that request was not
/// a salvage (here a checkpoint, answered `stale_epoch` while its answer was lost), the refusal says
/// nothing about this incarnation's work, so the salvage still runs. It used to end the retire,
/// deleting the disk unsalvaged.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_unanswered_checkpoint_still_lets_the_salvage_run() {
    let h = start_host_opts(None, 300).await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    *h.fleet.reject_next.lock().unwrap() = Some("stale_epoch".into());
    h.fleet.lose_commit_answers.store(1, Ordering::SeqCst);
    h.fleet.commands.send(vec![cmd("cmd_ck", CommandBody::SandboxCheckpoint { sandbox: sbx.clone(), epoch: Epoch(1), reason: CommitReason::TurnEnd })]).unwrap();
    assert!(!is_ok(&h.fleet.result("cmd_ck").await), "the checkpoint's answer is lost (commit_timeout_ms 300)");

    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![sbx], reason: "test".into() })]).unwrap();
    h.fleet.wait_event("retired", |b| matches!(b, HostEventBody::IncarnationRetired { epoch: Epoch(1), .. })).await;
    assert_eq!(salvage_requests(&h.fleet, "sbx_1", 1).len(), 1, "the salvage ran after the refused re-ask");
}

/// Inventory B2: a fence lands after a checkpoint's commit, while its VM is being resumed. The VM
/// runs (and writes) again before the fence task stops it, so the retire salvages. The retire used
/// to decide from the reported `dirty` flag, which the commit had just cleared, and deleted the
/// disk unsalvaged; it decides from the durable `clean` now.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fence_during_a_checkpoints_resume_still_salvages() {
    let h = start_host().await;
    let sbx = SandboxId("sbx_1".into());
    h.fleet.commands.send(vec![create("cmd_create", "sbx_1")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_create").await));
    h.resume_latch.held.store(true, Ordering::SeqCst);
    h.fleet.commands.send(vec![cmd("cmd_ck", CommandBody::SandboxCheckpoint { sandbox: sbx.clone(), epoch: Epoch(1), reason: CommitReason::TurnEnd })]).unwrap();
    wait_until("the checkpoint resumes its VM", || h.resume_latch.reached.load(Ordering::SeqCst)).await;
    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![sbx], reason: "test".into() })]).unwrap();
    h.fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    append_to_disk(h.dir.path(), "sbx_1", 1, b"written after the checkpoint");
    h.resume_latch.held.store(false, Ordering::SeqCst);
    h.resume_latch.release.notify_waiters();
    h.fleet.wait_event("retired", |b| matches!(b, HostEventBody::IncarnationRetired { epoch: Epoch(1), .. })).await;
    assert_eq!(salvage_requests(&h.fleet, "sbx_1", 1).len(), 1, "the work after the checkpoint is salvaged");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_final_salvage_refusal_ends_the_retire() {
    let h = start_host_opts(None, 300).await;
    h.fleet.commands.send(vec![create("cmd_c", "sbx_f")]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c").await));
    append_to_disk(h.dir.path(), "sbx_f", 1, b"work");
    *h.fleet.reject_salvage.lock().unwrap() = Some("stale_epoch".into());
    h.fleet.commands.send(vec![cmd("cmd_f", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_f".into())], reason: "test".into() })]).unwrap();
    h.fleet.wait_event("retired", |b| matches!(b, HostEventBody::IncarnationRetired { sandbox, epoch: Epoch(1) } if sandbox.0 == "sbx_f")).await;
    assert!(!h.dir.path().join("state/sandboxes/sbx_f").exists());
    // Past the first retry's backoff (RETIRE_RETRY_FIRST, 1 s): no second request.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(salvage_requests(&h.fleet, "sbx_f", 1).len(), 1, "a refused salvage was retried");
}

/// The review of the fix (M1): a fence of a newer epoch that superseded an older one here freezes
/// it through its own lock-free pause handle (pause handles are per incarnation).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_epoch_is_frozen_through_its_own_pause_handle() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create_at("cmd_c1", "sbx_p", 1)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c1").await));
    append_to_disk(h.dir.path(), "sbx_p", 1, b"work");
    h.fleet.commands.send(vec![create_at("cmd_c2", "sbx_p", 2)]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_c2").await));
    wait_until("the old incarnation retired", || !h.dir.path().join("state/sandboxes/sbx_p/1").exists()).await;
    h.fleet.commands.send(vec![cmd("cmd_f2", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_p".into())], reason: "test".into() })]).unwrap();
    assert!(is_ok(&h.fleet.result("cmd_f2").await));
    wait_until("the lock-free pause of epoch 2", || h.paused.lock().unwrap().contains(&("sbx_p".to_string(), 2))).await;
}

/// The review of the fix (L9): a configured cgroup delegation that fails doesn't stop nestd; it
/// runs on and says so in every fleet hello (here the cgroup root is a file, so no cgroup can be
/// made under it).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_cgroup_delegation_is_reported_in_the_hello() {
    let dir = tempfile::tempdir().unwrap();
    let not_a_cgroup_root = dir.path().join("cgroup-root-file");
    std::fs::write(&not_a_cgroup_root, b"").unwrap();
    let fleet = mock_fleet().await;
    let mut cfg = harness_config(dir.path(), &fleet.url, 5000);
    cfg.delegated_cgroup = true;
    cfg.cgroup_root = not_a_cgroup_root;
    let _host = Host::start(cfg, harness_enrolled(&fleet.url), Some(fake_driver())).await.unwrap();
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let hello = fleet.log.lock().unwrap().hellos[0].clone();
    assert!(hello.cgroup_delegation_error.is_some(), "the failed delegation is not reported");
}

/// A sandbox fence never fences the brains whose hands act in it: a brain survives its sandbox
/// moving. Brains are fenced by their own host's lease and their agent epoch; hands by the gateway.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_fence_leaves_its_brains_running() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    h.fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(bound_start("agt_b", "sbx_a")))]).unwrap();
    assert!(matches!(h.fleet.result("cmd_agent").await, CommandOutcome::Ok { .. }));
    wait_until("runner agent_start", || h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(_)))).await;
    h.fleet.commands.send(vec![cmd("cmd_fence", CommandBody::Fence { sandboxes: vec![SandboxId("sbx_a".into())], reason: "moved".into() })]).unwrap();
    h.fleet.wait_event("fenced", |b| matches!(b, HostEventBody::SandboxState { state: SandboxState::Fenced, .. })).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::Fence { .. })), "a sandbox fence fenced a brain");
    assert!(!h.fleet.log.lock().unwrap().events.iter().any(|e| matches!(e.body, HostEventBody::AgentExited { .. })));
}

fn bound_start(agent: &str, sandbox: &str) -> AgentStart {
    AgentStart {
        agent: AgentId(agent.into()),
        role: None,
        workstream: WorkstreamId("ws_1".into()),
        epoch: Some(Epoch(1)),
        resume: None,
        hands: Some(HandsBinding { sandbox: SandboxId(sandbox.into()), epoch: None }),
        launch: LaunchConfig { model: None, effort: None, builtin_tools: vec![], system_prompt: SystemPrompt::Append { text: "w".into() } },
        oauth_token: "oauth".into(),
        session_ws_url: "ws://x".into(),
    }
}

/// A kill takes effect on arrival, not behind a slow command in the in-order executor, and its
/// result goes out on arrival too (AgentDO's escalation reads a kill with a result as "this host
/// processes commands"); the in-order pass doesn't kill again.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_applies_on_arrival_behind_slow_commands() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    h.fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(bound_start("agt_b", "sbx_a")))]).unwrap();
    assert!(matches!(h.fleet.result("cmd_agent").await, CommandOutcome::Ok { .. }));
    wait_until("runner agent_start", || h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(_)))).await;
    h.fleet.commands.send(vec![create("cmd_slow", "sbx_slow2")]).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let t0 = std::time::Instant::now();
    let stop = CommandBody::AgentStop { agent: AgentId("agt_b".into()), reason: "starting elsewhere".into(), mode: Some(nest_protocol::host::runner::StopMode::Kill), epoch: Some(Epoch(1)) };
    h.fleet.commands.send(vec![cmd("cmd_kill", stop)]).unwrap();
    wait_until("the runner gets the kill", || {
        h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStop { mode: nest_protocol::host::runner::StopMode::Kill, .. }))
    })
    .await;
    assert!(t0.elapsed() < Duration::from_millis(800), "waited behind the slow create: {:?}", t0.elapsed());
    assert!(matches!(h.fleet.result("cmd_kill").await, CommandOutcome::Ok { .. }));
    assert!(h.fleet.results_for("cmd_slow").is_empty(), "the kill's result came on arrival, not behind the slow command");
    let kills = h._runner.lock().unwrap().iter().filter(|c| matches!(c, RunnerCommand::AgentStop { .. })).count();
    assert_eq!(kills, 1, "the in-order pass does not kill again");
}

/// The epoch tombstone: a kill that overtakes a start still queued behind a slow command makes that
/// start never run (its exit is reported, so AgentDO can start the agent elsewhere), and a kill for a
/// brain that isn't running here is answered with its exit at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_kill_overtaking_a_queued_start_means_it_never_runs() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    // A slow create occupies the executor; the start for agt_q at epoch 1 queues behind it.
    h.fleet.commands.send(vec![create("cmd_slow", "sbx_slow2"), cmd("cmd_agent", CommandBody::AgentStart(bound_start("agt_q", "sbx_a")))]).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let stop = CommandBody::AgentStop { agent: AgentId("agt_q".into()), reason: "starting elsewhere".into(), mode: Some(nest_protocol::host::runner::StopMode::Kill), epoch: Some(Epoch(1)) };
    h.fleet.commands.send(vec![cmd("cmd_kill", stop)]).unwrap();
    // Not running here yet: its exit (at the kill's epoch) is reported on arrival.
    h.fleet.wait_event("the exit of the brain that never ran", |b| matches!(b, HostEventBody::AgentExited { agent, epoch: Some(Epoch(1)), .. } if agent.0 == "agt_q")).await;
    assert!(h.fleet.results_for("cmd_slow").is_empty(), "the exit came on the kill's arrival, not behind the slow command");
    // The queued start, reached in order, is refused and never reaches the runner.
    match h.fleet.result("cmd_agent").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("the overtaken start ran: {other:?}"),
    }
    assert!(!h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_q")));
    // A newer start (epoch 2) runs.
    let mut newer = bound_start("agt_q", "sbx_a");
    newer.epoch = Some(Epoch(2));
    h.fleet.commands.send(vec![cmd("cmd_agent2", CommandBody::AgentStart(newer))]).unwrap();
    assert!(matches!(h.fleet.result("cmd_agent2").await, CommandOutcome::Ok { .. }));
}

/// Amendment A3 (a): a start never outlives a lease lapse. One queued behind a slow command when the
/// lease lapses is refused when the executor reaches it, even after the lease was renewed; its exit
/// (`fenced`, at its epoch) is reported and it never reaches the runner.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_start_held_across_a_lease_lapse_never_runs() {
    let h = start_host().await;
    h.fleet.commands.send(vec![create("cmd_a", "sbx_a")]).unwrap();
    assert!(matches!(h.fleet.result("cmd_a").await, CommandOutcome::Ok { .. }));
    h.fleet.commands.send(vec![create("cmd_slow", "sbx_slow2"), cmd("cmd_agent", CommandBody::AgentStart(bound_start("agt_l", "sbx_a")))]).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    h.fleet.partition.store(true, Ordering::SeqCst); // the lease lapses while the start waits
    wait_until("runner fence", || h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::Fence { .. }))).await;
    h.fleet.partition.store(false, Ordering::SeqCst); // renewed before the executor reaches the start
    match h.fleet.result("cmd_agent").await {
        CommandOutcome::Error { error } => assert_eq!(error.code, "stale_epoch"),
        other => panic!("a start held across a lapse ran: {other:?}"),
    }
    h.fleet.wait_event("its exit", |b| matches!(b, HostEventBody::AgentExited { agent, epoch: Some(Epoch(1)), reason: AgentExitReason::Fenced, .. } if agent.0 == "agt_l")).await;
    assert!(!h._runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_l")));
}

/// A brain host runs nestd's supervisor duties only: no proxy or gateway socket, no driver; it
/// says hello with no gateway URL and no tunnel, refuses every sandbox command with a clear error,
/// starts brains through the runner, and self-fences them when its lease lapses.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_brain_host_runs_brains_and_refuses_sandboxes() {
    let dir = tempfile::tempdir().unwrap();
    let fleet = mock_fleet().await;
    let cfg: Config = serde_json::from_value(serde_json::json!({
        "role": "brain", "cell": "test-cell",
        "enrollment": {"type": "static", "host": "hst_t", "host_token": "tok", "fleet_ws_url": fleet.url},
        "run_dir": dir.path().join("run"), "state_dir": dir.path().join("state"), "flush_interval_ms": 20,
    }))
    .unwrap();
    let enrolled = Enrolled { host: HostId("hst_t".into()), host_token: nest_protocol::host::Secret("tok".into()), host_token_expires_ms: i64::MAX, fleet_ws_url: fleet.url.clone(), proxy_ca: None, tunnel_token: None, gateway_url: None };
    let _host = Host::start(cfg, enrolled, None).await.unwrap();
    let runner = fake_runner(&dir.path().join("run/runner.sock")).await;
    wait_until("fleet hello", || !fleet.log.lock().unwrap().hellos.is_empty()).await;
    let hello = fleet.log.lock().unwrap().hellos[0].clone();
    assert_eq!(hello.role, HostRole::Brain);
    assert_eq!(hello.gateway_url, None);
    assert_eq!(hello.tunnel, TunnelState::None);
    // All its vCPUs are free (no sandbox holds any): FleetDO's default brain capacity counts them.
    let vcpus = std::thread::available_parallelism().unwrap().get() as u32;
    assert_eq!((hello.capacity.vcpus_free, hello.capacity.sandboxes), (vcpus, 0));
    assert!(!dir.path().join("run/proxy.sock").exists(), "a brain host binds no proxy socket");
    assert!(!dir.path().join("run/gateway.sock").exists(), "a brain host binds no gateway socket");

    fleet.commands.send(vec![create("cmd_sbx", "sbx_b")]).unwrap();
    match fleet.result("cmd_sbx").await {
        CommandOutcome::Error { error } => {
            assert_eq!(error.code, "forbidden");
            assert!(error.message.contains("brain host"), "{}", error.message);
            assert!(!error.retryable);
        }
        other => panic!("a brain host took a sandbox: {other:?}"),
    }
    assert!(!dir.path().join("state/sandboxes/sbx_b").exists());

    fleet.commands.send(vec![cmd("cmd_agent", CommandBody::AgentStart(bound_start("agt_b", "sbx_elsewhere")))]).unwrap();
    assert!(matches!(fleet.result("cmd_agent").await, CommandOutcome::Ok { .. }));
    wait_until("runner agent_start", || runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::AgentStart(s) if s.start.agent.0 == "agt_b"))).await;

    fleet.partition.store(true, Ordering::SeqCst);
    wait_until("the brains fenced at the lease lapse", || runner.lock().unwrap().iter().any(|c| matches!(c, RunnerCommand::Fence { .. }))).await;
}

/// Install a fake binary without this process ever holding it open for writing: a child another
/// test thread forks meanwhile inherits a write descriptor until it execs, and running the file in
/// that window fails with ETXTBSY. The bytes go to a staging file; `cp`, its own process, writes
/// the executable. (Same as `nest_runner::test_support::install_executable`.)
fn install_executable(path: &Path, contents: impl AsRef<[u8]>) {
    use std::os::unix::fs::PermissionsExt;
    let staging = PathBuf::from(format!("{}.staging", path.display()));
    std::fs::write(&staging, contents).unwrap();
    assert!(std::process::Command::new("cp").arg(&staging).arg(path).status().unwrap().success());
    std::fs::remove_file(&staging).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}
