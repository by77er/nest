//! nestd's persistent control connection to a sandbox's guest agent (vsock port 1024,
//! `docs/interfaces/host-guest/`).
//!
//! One task per sandbox. It (re)connects with backoff, validates `hello`, sends `configure` with
//! the current agent slots (and `resume` after a restore), then relays guest events and serves
//! host requests (`agent_attach`, `prepare_snapshot`, …) correlated by id.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::guest::frame::{self, Decoder, Kind};
use nest_protocol::guest::{AgentSlot, CliCommand, CliResult, ControlBody, ControlFrame, ForkIdentity, PORT_CONTROL, PROTOCOL_VERSION};
use nest_protocol::model::{AgentId, Epoch, SandboxId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};

use crate::util::{error, now_ms, random_hex};
use crate::vsock;

/// What the guest tells nestd.
#[derive(Debug)]
pub enum GuestEvent {
    /// Configured and ready for hands calls. `resumed`: same `boot_id` and `instance_id` as before
    /// (memory restore). `guest`: the version and capabilities from this connection's hello.
    Ready { resumed: bool, guest: nest_protocol::gateway::GuestInfo },
    Disconnected,
    Ports(Vec<nest_protocol::guest::ListeningPort>),
    TaskExited { agent_id: AgentId, task: nest_protocol::guest::TaskInfo },
    /// A `nest` CLI command from inside the sandbox; answer through `reply`.
    Cli { agent_id: Option<AgentId>, command: CliCommand, reply: oneshot::Sender<CliResult> },
}

#[derive(Clone)]
struct Config {
    sandbox: SandboxId,
    epoch: Epoch,
    hostname: String,
    slots: Vec<AgentSlot>,
}

enum Req {
    Send { body: ControlBody, reply: oneshot::Sender<io::Result<ControlBody>> },
}

/// Handle to one sandbox's control connection.
#[derive(Clone)]
pub struct GuestCtl {
    cfg: Arc<Mutex<Config>>,
    reqs: mpsc::UnboundedSender<Req>,
    ready: watch::Receiver<bool>,
    /// Resume to send after the next `hello` (set before restoring a memory snapshot).
    pending_resume: Arc<Mutex<Option<Option<ForkIdentity>>>>,
    stop: Arc<tokio::sync::Notify>,
    /// The guest's version and capabilities from the last hello (what `resolve` hands clients).
    guest: Arc<Mutex<Option<nest_protocol::gateway::GuestInfo>>>,
}

impl GuestCtl {
    /// Connect to the guest behind `uds`; every `configure` carries `slots` and those attached since.
    pub fn spawn(uds: PathBuf, sandbox: SandboxId, epoch: Epoch, hostname: String, slots: Vec<AgentSlot>, events: mpsc::UnboundedSender<(SandboxId, GuestEvent)>) -> GuestCtl {
        let cfg = Arc::new(Mutex::new(Config { sandbox: sandbox.clone(), epoch, hostname, slots }));
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = watch::channel(false);
        let ctl = GuestCtl { cfg, reqs: tx, ready: ready_rx, pending_resume: Arc::new(Mutex::new(None)), stop: Arc::new(tokio::sync::Notify::new()), guest: Arc::new(Mutex::new(None)) };
        let task = Task { uds, ctl: ctl.clone(), events, ready: ready_tx, sandbox, last_identity: None };
        tokio::spawn(task.run(rx));
        ctl
    }

    /// Wait until the guest has been configured (or `timeout`).
    pub async fn wait_ready(&self, timeout: Duration) -> io::Result<()> {
        let mut r = self.ready.clone();
        tokio::time::timeout(timeout, r.wait_for(|v| *v))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest agent did not become ready"))?
            .map(|_| ())
            .map_err(|_| io::Error::other("guest control task ended"))
    }

    pub fn is_ready(&self) -> bool {
        *self.ready.borrow()
    }

    /// The guest's version and capabilities from its last hello, if one arrived.
    pub fn guest(&self) -> Option<nest_protocol::gateway::GuestInfo> {
        self.guest.lock().expect("guest info").clone()
    }

    pub fn slots(&self) -> Vec<AgentSlot> {
        self.cfg.lock().expect("guest cfg").slots.clone()
    }

    /// Send a request and wait for its reply. Errors if not connected.
    pub async fn request(&self, body: ControlBody) -> io::Result<ControlBody> {
        let (tx, rx) = oneshot::channel();
        self.reqs.send(Req::Send { body, reply: tx }).map_err(|_| io::Error::other("guest control task ended"))?;
        tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest request timed out"))?
            .map_err(|_| io::Error::other("guest control connection dropped"))?
    }

    /// Add an agent slot (persisted for reconfiguration after reconnects).
    pub async fn attach(&self, slot: AgentSlot) -> io::Result<()> {
        {
            let mut c = self.cfg.lock().expect("guest cfg");
            c.slots.retain(|s| s.agent_id != slot.agent_id);
            c.slots.push(slot.clone());
        }
        expect_ok(self.request(ControlBody::AgentAttach { slot }).await?)
    }

    /// Drop an agent's slot from the set `configure` sends, without telling the guest (a slot
    /// that never took, or one nestd no longer has).
    pub fn forget_slot(&self, agent: &AgentId) {
        self.cfg.lock().expect("guest cfg").slots.retain(|s| &s.agent_id != agent);
    }

    pub async fn detach(&self, agent: &AgentId, kill_processes: bool) -> io::Result<()> {
        self.cfg.lock().expect("guest cfg").slots.retain(|s| &s.agent_id != agent);
        if !self.is_ready() {
            return Ok(()); // the next `configure` carries the reduced slot set
        }
        expect_ok(self.request(ControlBody::AgentDetach { agent_id: agent.clone(), kill_processes }).await?)
    }

    pub async fn prepare_snapshot(&self, drop_caches: bool) -> io::Result<()> {
        expect_ok(self.request(ControlBody::PrepareSnapshot { drop_caches, fsfreeze: vec![] }).await?)
    }

    pub async fn thaw(&self) -> io::Result<()> {
        expect_ok(self.request(ControlBody::Thaw {}).await?)
    }

    /// Arrange for `resume` (clock + entropy, optional fork identity) after the next hello.
    pub fn expect_resume(&self, fork: Option<ForkIdentity>) {
        *self.pending_resume.lock().expect("resume") = Some(fork);
    }

    pub fn set_epoch(&self, epoch: Epoch) {
        self.cfg.lock().expect("guest cfg").epoch = epoch;
    }

    /// Stop the connection task (sandbox stopped, fenced or destroyed).
    pub fn shutdown(&self) {
        self.stop.notify_one();
    }
}

fn expect_ok(b: ControlBody) -> io::Result<()> {
    match b {
        ControlBody::Ok {} => Ok(()),
        ControlBody::Error { error } => Err(io::Error::other(format!("guest: {}: {}", error.code, error.message))),
        other => Err(io::Error::other(format!("unexpected guest reply {other:?}"))),
    }
}

struct Task {
    uds: PathBuf,
    ctl: GuestCtl,
    events: mpsc::UnboundedSender<(SandboxId, GuestEvent)>,
    ready: watch::Sender<bool>,
    sandbox: SandboxId,
    /// `(boot_id, instance_id)` from the previous hello.
    last_identity: Option<(String, String)>,
}

type Conn = tokio::io::BufReader<tokio::net::UnixStream>;

impl Task {
    async fn run(mut self, mut reqs: mpsc::UnboundedReceiver<Req>) {
        let stop = self.ctl.stop.clone();
        let mut backoff = Duration::from_millis(50);
        loop {
            let attempt = async {
                let conn = vsock::connect(&self.uds, PORT_CONTROL).await?;
                self.session(conn, &mut reqs).await
            };
            tokio::select! {
                _ = stop.notified() => break,
                r = attempt => {
                    if self.ready.send_replace(false) {
                        let _ = self.events.send((self.sandbox.clone(), GuestEvent::Disconnected));
                    }
                    match r {
                        Ok(()) => backoff = Duration::from_millis(50),
                        Err(e) => tracing::debug!(sandbox = %self.sandbox, error = %e, "guest control connection"),
                    }
                }
            }
            // Fail queued requests while disconnected.
            while let Ok(Req::Send { reply, .. }) = reqs.try_recv() {
                let _ = reply.send(Err(io::Error::new(io::ErrorKind::NotConnected, "guest not connected")));
            }
            tokio::select! {
                _ = stop.notified() => break,
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(2));
        }
        self.ready.send_replace(false);
    }

    async fn session(&mut self, conn: Conn, reqs: &mut mpsc::UnboundedReceiver<Req>) -> io::Result<()> {
        // Created before the handshake: the guest may relay `cli` (and flush buffered
        // `task_exited`) as soon as `configure` succeeds, while `resume` is still in flight.
        let (cli_tx, mut cli_rx) = mpsc::unbounded_channel();
        let mut c = Session::new(conn, cli_tx);
        let r = self.serve(&mut c, reqs, &mut cli_rx).await;
        for (_, reply) in c.pending.drain() {
            let _ = reply.send(Err(io::Error::new(io::ErrorKind::ConnectionReset, "guest control connection closed")));
        }
        r
    }

    async fn serve(&mut self, c: &mut Session, reqs: &mut mpsc::UnboundedReceiver<Req>, cli_rx: &mut mpsc::UnboundedReceiver<(u64, CliResult)>) -> io::Result<()> {
        // 1. hello
        let hello = c.next_within(HANDSHAKE_READ).await?;
        let ControlBody::Hello { protocol_version, boot_id, instance_id, capabilities, .. } = hello.body else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "first guest frame was not hello"));
        };
        if protocol_version != PROTOCOL_VERSION {
            let e = ControlFrame { id: None, reply_to: None, body: ControlBody::Error { error: error("unsupported_version", format!("host speaks {PROTOCOL_VERSION}"), false) } };
            let _ = c.write(&e).await;
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("guest protocol {protocol_version}")));
        }
        // Same boot and same guest-agent process = memory restore. Same boot, new process = the
        // agent restarted (configure again, no resume). New boot = reboot.
        let identity = (boot_id, instance_id);
        let resumed = self.last_identity.as_ref() == Some(&identity);
        if let Some((last_boot, last_instance)) = &self.last_identity
            && *last_boot == identity.0
            && *last_instance != identity.1
        {
            tracing::info!(sandbox = %self.sandbox, "guest agent restarted within the same boot");
        }
        self.last_identity = Some(identity);

        // 2. configure (complete slot set), then resume if a restore is pending.
        let cfg = self.ctl.cfg.lock().expect("guest cfg").clone();
        let body = ControlBody::Configure { sandbox_id: cfg.sandbox, epoch: cfg.epoch, hostname: cfg.hostname, agents: cfg.slots };
        expect_ok(self.call(c, body).await?)?;
        let resume = self.ctl.pending_resume.lock().expect("resume").take();
        if let Some(fork) = resume {
            let mut entropy = [0u8; 64];
            rand::fill(&mut entropy[..]);
            use base64::Engine as _;
            let body = ControlBody::Resume { wall_clock_ms: now_ms(), entropy_b64: base64::engine::general_purpose::STANDARD.encode(entropy), fork: fork.clone() };
            let reply = self.call(c, body).await;
            if let Ok(ControlBody::ResumeDone { clock_step_ms }) = reply {
                tracing::info!(sandbox = %self.sandbox, clock_step_ms, "guest resumed");
            } else {
                // Not resumed (its clock or RNG not reseeded): not ready, and the next connection
                // asks again, unless a newer resume was asked for meanwhile.
                self.ctl.pending_resume.lock().expect("resume").get_or_insert(fork);
                return Err(match reply {
                    Err(e) => e,
                    Ok(ControlBody::Error { error }) => io::Error::other(format!("guest resume: {}: {}", error.code, error.message)),
                    Ok(other) => io::Error::other(format!("unexpected resume reply {other:?}")),
                });
            }
        }
        let guest = nest_protocol::gateway::GuestInfo { protocol_version, capabilities };
        *self.ctl.guest.lock().expect("guest info") = Some(guest.clone());
        self.ready.send_replace(true);
        let _ = self.events.send((self.sandbox.clone(), GuestEvent::Ready { resumed, guest }));

        // 3. steady state
        loop {
            tokio::select! {
                // Cancel-safe: a frame already decoded is returned without awaiting.
                f = c.next() => {
                    let Some(f) = f? else { return Ok(()) };
                    self.route(c, f);
                }
                req = reqs.recv() => {
                    let Some(Req::Send { body, reply }) = req else { return Ok(()) };
                    match c.send(body).await {
                        Ok(id) => { c.pending.insert(id, reply); }
                        Err(e) => {
                            let _ = reply.send(Err(e));
                            return Ok(());
                        }
                    }
                }
                cli = cli_rx.recv() => {
                    let Some((id, result)) = cli else { continue };
                    c.write(&ControlFrame { id: None, reply_to: Some(id), body: ControlBody::CliResult { result } }).await?;
                }
            }
        }
    }

    /// Route a frame that isn't the handshake's reply: replies to their waiters, events and CLI
    /// relays to nestd.
    fn route(&self, c: &mut Session, cf: ControlFrame) {
        if let Some(r) = cf.reply_to {
            if let Some(tx) = c.pending.remove(&r) {
                let _ = tx.send(Ok(cf.body));
            }
            return;
        }
        let sbx = self.sandbox.clone();
        match cf.body {
            ControlBody::Ports { listening, .. } => {
                let _ = self.events.send((sbx, GuestEvent::Ports(listening)));
            }
            ControlBody::TaskExited { agent_id, task } => {
                let _ = self.events.send((sbx, GuestEvent::TaskExited { agent_id, task }));
            }
            ControlBody::Cli { agent_id, command } => {
                let Some(id) = cf.id else { return };
                let (tx, rx) = oneshot::channel();
                let _ = self.events.send((sbx, GuestEvent::Cli { agent_id, command, reply: tx }));
                let cli_tx = c.cli_tx.clone();
                tokio::spawn(async move {
                    let result = rx.await.unwrap_or_else(|_| CliResult::Error { error: error("internal", "nestd dropped the request", true) });
                    let _ = cli_tx.send((id, result));
                });
            }
            other => tracing::debug!(?other, "ignoring unexpected guest message"),
        }
    }

    /// Request/reply during the handshake (before the steady-state loop runs). Every other frame
    /// that arrives meanwhile (ports, `task_exited`, `cli`) is routed normally, not dropped.
    async fn call(&self, c: &mut Session, body: ControlBody) -> io::Result<ControlBody> {
        let id = c.send(body).await?;
        loop {
            let f = c.next_within(HANDSHAKE_READ).await?;
            if f.reply_to == Some(id) {
                return Ok(f.body);
            }
            self.route(c, f);
        }
    }
}

/// How long a handshake read waits for the guest.
const HANDSHAKE_READ: Duration = Duration::from_secs(10);

/// One control connection: its two halves, the decoder over what was read, and the requests
/// awaiting a reply.
struct Session {
    rd: tokio::net::unix::OwnedReadHalf,
    wr: tokio::net::unix::OwnedWriteHalf,
    dec: Decoder,
    buf: Vec<u8>,
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<io::Result<ControlBody>>>,
    /// Where a relayed CLI command's answer goes, to be written back by the session.
    cli_tx: mpsc::UnboundedSender<(u64, CliResult)>,
}

impl Session {
    fn new(conn: Conn, cli_tx: mpsc::UnboundedSender<(u64, CliResult)>) -> Session {
        let mut dec = Decoder::new();
        // Any bytes buffered after the handshake line belong to the frame stream.
        dec.push(conn.buffer());
        let (rd, wr) = conn.into_inner().into_split();
        Session { rd, wr, dec, buf: vec![0u8; 64 << 10], next_id: 1, pending: HashMap::new(), cli_tx }
    }

    /// The next control frame, or `None` at the end of the stream. Cancel-safe.
    async fn next(&mut self) -> io::Result<Option<ControlFrame>> {
        loop {
            if let Some(f) = self.dec.next_frame().map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))? {
                if f.kind != Kind::Json {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "DATA frame on control channel"));
                }
                return serde_json::from_slice(&f.payload).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
            }
            let n = self.rd.read(&mut self.buf).await?;
            if n == 0 {
                return Ok(None);
            }
            self.dec.push(&self.buf[..n]);
        }
    }

    /// The next control frame within `limit`; the end of the stream is an error.
    async fn next_within(&mut self, limit: Duration) -> io::Result<ControlFrame> {
        tokio::time::timeout(limit, self.next())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest control read timed out"))??
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "guest closed control connection"))
    }

    /// Send a request; its id.
    async fn send(&mut self, body: ControlBody) -> io::Result<u64> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&ControlFrame { id: Some(id), reply_to: None, body }).await?;
        Ok(id)
    }

    async fn write(&mut self, f: &ControlFrame) -> io::Result<()> {
        let bytes = frame::encode_json(f).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        self.wr.write_all(&bytes).await
    }
}

/// 32 lowercase hex chars for a forked guest's `/etc/machine-id`.
pub fn new_machine_id() -> String {
    random_hex(16)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::Path;
    use tokio::net::UnixListener;

    /// In-process fake guest agent: listens on `<dir>/1024.sock`, speaks the control protocol,
    /// records every host request it gets.
    pub struct FakeGuest {
        pub seen: Arc<Mutex<Vec<ControlBody>>>,
        pub task: tokio::task::JoinHandle<()>,
    }

    impl FakeGuest {
        pub fn start(guest_dir: &Path, boot_id: &str) -> FakeGuest {
            std::fs::create_dir_all(guest_dir).unwrap();
            let listener = UnixListener::bind(guest_dir.join("1024.sock")).unwrap();
            let seen = Arc::new(Mutex::new(vec![]));
            let seen2 = seen.clone();
            let boot_id = boot_id.to_string();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut s, _)) = listener.accept().await else { break };
                    let hello = ControlFrame { id: None, reply_to: None, body: ControlBody::Hello { protocol_version: PROTOCOL_VERSION, agent_version: "fake".into(), boot_id: boot_id.clone(), instance_id: "fakeinstance0001".into(), since_boot_ms: 1, capabilities: vec![] } };
                    s.write_all(&frame::encode_json(&hello).unwrap()).await.unwrap();
                    let mut dec = Decoder::new();
                    let mut buf = vec![0u8; 65536];
                    'conn: loop {
                        let n = match s.read(&mut buf).await { Ok(0) | Err(_) => break 'conn, Ok(n) => n };
                        dec.push(&buf[..n]);
                        while let Ok(Some(f)) = dec.next_frame() {
                            let cf: ControlFrame = serde_json::from_slice(&f.payload).unwrap();
                            seen2.lock().unwrap().push(cf.body.clone());
                            let reply = match cf.body {
                                ControlBody::Resume { .. } => ControlBody::ResumeDone { clock_step_ms: 0 },
                                ControlBody::Configure { .. } => {
                                    // Announce a listening port right after configure.
                                    let ports = ControlFrame { id: None, reply_to: None, body: ControlBody::Ports { listening: vec![nest_protocol::guest::ListeningPort { port: 5173, proto: nest_protocol::guest::PortProto::Tcp, bind: "loopback".into(), pid: None, process: None }], ts_ms: 1 } };
                                    let ok = ControlFrame { id: None, reply_to: cf.id, body: ControlBody::Ok {} };
                                    s.write_all(&frame::encode_json(&ok).unwrap()).await.unwrap();
                                    s.write_all(&frame::encode_json(&ports).unwrap()).await.unwrap();
                                    continue;
                                }
                                _ => ControlBody::Ok {},
                            };
                            let r = ControlFrame { id: None, reply_to: cf.id, body: reply };
                            if s.write_all(&frame::encode_json(&r).unwrap()).await.is_err() { break 'conn; }
                        }
                    }
                }
            });
            FakeGuest { seen, task }
        }
    }

    #[tokio::test]
    async fn configure_attach_and_reconnect_resume() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        let fake = FakeGuest::start(&guest_dir, "boot-1");
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, mut erx) = mpsc::unbounded_channel();
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(3), "sbx-1".into(), vec![], etx);
        ctl.wait_ready(Duration::from_secs(5)).await.unwrap();
        assert!(matches!(erx.recv().await, Some((_, GuestEvent::Ready { resumed: false, guest })) if guest.protocol_version == PROTOCOL_VERSION));
        assert!(matches!(erx.recv().await, Some((_, GuestEvent::Ports(p))) if p[0].port == 5173));

        let slot = AgentSlot { agent_id: AgentId("agt_1".into()), proxy_port: 3128, cwd: "/workspace".into(), env: Default::default(), memory_max_bytes: None };
        ctl.attach(slot).await.unwrap();
        ctl.prepare_snapshot(true).await.unwrap();

        // Simulate a restore: drop the connection; same boot id ⇒ resumed, and `resume` is sent.
        ctl.expect_resume(None);
        fake.task.abort();
        let _ = std::fs::remove_file(guest_dir.join("1024.sock"));
        let fake2 = FakeGuest::start(&guest_dir, "boot-1");
        loop {
            match erx.recv().await.unwrap().1 {
                GuestEvent::Ready { resumed, .. } => { assert!(resumed); break; }
                _ => continue,
            }
        }
        let seen = fake2.seen.lock().unwrap().clone();
        assert!(matches!(&seen[0], ControlBody::Configure { epoch: Epoch(3), agents, .. } if agents.len() == 1));
        assert!(matches!(&seen[1], ControlBody::Resume { fork: None, .. }));
        ctl.shutdown();
    }

    /// A `resume` the guest refuses (it couldn't reseed its RNG, say) is a failed readiness: the
    /// sandbox isn't reported ready, and the next connection asks again. It used to be logged and
    /// the guest reported ready, unreseeded.
    #[tokio::test]
    async fn a_refused_resume_is_not_ready_and_is_asked_again() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        std::fs::create_dir_all(&guest_dir).unwrap();
        let listener = UnixListener::bind(guest_dir.join("1024.sock")).unwrap();
        let resumes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let resumes2 = resumes.clone();
        tokio::spawn(async move {
            let send = |b: ControlBody, reply_to: Option<u64>| frame::encode_json(&ControlFrame { id: None, reply_to, body: b }).unwrap();
            loop {
                let Ok((mut s, _)) = listener.accept().await else { break };
                s.write_all(&send(ControlBody::Hello { protocol_version: PROTOCOL_VERSION, agent_version: "f".into(), boot_id: "b".into(), instance_id: "i".into(), since_boot_ms: 1, capabilities: vec![] }, None)).await.unwrap();
                let mut dec = Decoder::new();
                let mut buf = vec![0u8; 65536];
                'conn: loop {
                    let n = match s.read(&mut buf).await { Ok(0) | Err(_) => break 'conn, Ok(n) => n };
                    dec.push(&buf[..n]);
                    while let Ok(Some(f)) = dec.next_frame() {
                        let cf: ControlFrame = serde_json::from_slice(&f.payload).unwrap();
                        let reply = match cf.body {
                            ControlBody::Resume { .. } if resumes2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 => {
                                ControlBody::Error { error: error("internal", "can't reseed the RNG", true) }
                            }
                            ControlBody::Resume { .. } => ControlBody::ResumeDone { clock_step_ms: 0 },
                            _ => ControlBody::Ok {},
                        };
                        if s.write_all(&send(reply, cf.id)).await.is_err() {
                            break 'conn;
                        }
                    }
                }
            }
        });
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, mut erx) = mpsc::unbounded_channel();
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(1), "h".into(), vec![], etx);
        ctl.expect_resume(None);
        loop {
            match tokio::time::timeout(Duration::from_secs(5), erx.recv()).await.unwrap().unwrap().1 {
                GuestEvent::Ready { .. } => break,
                _ => continue,
            }
        }
        assert_eq!(resumes.load(std::sync::atomic::Ordering::SeqCst), 2, "ready only once a resume was done");
        ctl.shutdown();
    }

    /// Docs review #6: a `cli` relay and a `task_exited` the guest sends right after `configure`,
    /// while nestd is still waiting for the `resume` reply, are routed (not dropped), and the CLI
    /// answer reaches the guest.
    #[tokio::test]
    async fn frames_during_resume_handshake_are_routed() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        std::fs::create_dir_all(&guest_dir).unwrap();
        let listener = UnixListener::bind(guest_dir.join("1024.sock")).unwrap();
        let got_answer = Arc::new(Mutex::new(None));
        let got2 = got_answer.clone();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let send = |b: ControlBody, id: Option<u64>, reply_to: Option<u64>| frame::encode_json(&ControlFrame { id, reply_to, body: b }).unwrap();
            s.write_all(&send(ControlBody::Hello { protocol_version: PROTOCOL_VERSION, agent_version: "f".into(), boot_id: "b".into(), instance_id: "i".into(), since_boot_ms: 1, capabilities: vec![] }, None, None)).await.unwrap();
            let mut dec = Decoder::new();
            let mut buf = vec![0u8; 65536];
            loop {
                let n = s.read(&mut buf).await.unwrap();
                if n == 0 { break; }
                dec.push(&buf[..n]);
                while let Ok(Some(f)) = dec.next_frame() {
                    let cf: ControlFrame = serde_json::from_slice(&f.payload).unwrap();
                    match cf.body {
                        ControlBody::Configure { .. } => s.write_all(&send(ControlBody::Ok {}, None, cf.id)).await.unwrap(),
                        ControlBody::Resume { .. } => {
                            // Before answering resume: a CLI relay and a task exit.
                            s.write_all(&send(ControlBody::Cli { agent_id: None, command: CliCommand::Whoami {} }, Some(77), None)).await.unwrap();
                            let task = nest_protocol::guest::TaskInfo { task_id: "bg".into(), description: None, status: nest_protocol::guest::TaskStatus::Exited, exit_code: Some(0), output_path: "/x".into(), output_bytes: 0, started_ms: 1, ended_ms: Some(2) };
                            s.write_all(&send(ControlBody::TaskExited { agent_id: AgentId("agt_1".into()), task }, None, None)).await.unwrap();
                            s.write_all(&send(ControlBody::ResumeDone { clock_step_ms: 0 }, None, cf.id)).await.unwrap();
                        }
                        ControlBody::CliResult { result } if cf.reply_to == Some(77) => *got2.lock().unwrap() = Some(result),
                        _ => {}
                    }
                }
            }
        });
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, mut erx) = mpsc::unbounded_channel();
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(1), "h".into(), vec![], etx);
        ctl.expect_resume(None);
        let (mut saw_cli, mut saw_task, mut ready) = (false, false, false);
        while !(saw_cli && saw_task && ready) {
            match tokio::time::timeout(Duration::from_secs(5), erx.recv()).await.unwrap().unwrap().1 {
                GuestEvent::Cli { reply, .. } => {
                    saw_cli = true;
                    let _ = reply.send(CliResult::Ok { data: serde_json::Value::Null });
                }
                GuestEvent::TaskExited { .. } => saw_task = true,
                GuestEvent::Ready { .. } => ready = true,
                _ => {}
            }
        }
        for _ in 0..200 {
            if got_answer.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(matches!(got_answer.lock().unwrap().clone(), Some(CliResult::Ok { .. })));
        ctl.shutdown();
    }
}
