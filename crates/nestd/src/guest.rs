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

use nest_protocol::guest::framed::{FramedReader, write_json};
use nest_protocol::guest::{AgentSlot, CliCommand, CliResult, ControlBody, ControlFrame, ForkIdentity, PORT_CONTROL, PROTOCOL_VERSION};
use nest_protocol::model::{AgentId, Epoch, SandboxId};
use nestd_core::detach::{Detaches, Owed};
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
    /// What `configure` carries: every attached agent, and every agent whose detach the guest
    /// hasn't confirmed yet (`detaches`), so a reconnect never drops one before its detach arrives.
    slots: Vec<AgentSlot>,
    /// Detaches the guest hasn't confirmed (`nestd_core::detach`): sent after every `configure`.
    detaches: Detaches<AgentId>,
}

struct Req {
    body: ControlBody,
    reply: oneshot::Sender<io::Result<ControlBody>>,
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
        Self::spawn_sweeping(uds, sandbox, epoch, hostname, slots, events, OWED_SWEEP)
    }

    /// [`GuestCtl::spawn`], sending owed detaches to a connected guest every `sweep`.
    fn spawn_sweeping(uds: PathBuf, sandbox: SandboxId, epoch: Epoch, hostname: String, slots: Vec<AgentSlot>, events: mpsc::UnboundedSender<(SandboxId, GuestEvent)>, sweep: Duration) -> GuestCtl {
        let cfg = Arc::new(Mutex::new(Config { sandbox: sandbox.clone(), epoch, hostname, slots, detaches: Detaches::new() }));
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = watch::channel(false);
        let ctl = GuestCtl { cfg, reqs: tx, ready: ready_rx, pending_resume: Arc::new(Mutex::new(None)), stop: Arc::new(tokio::sync::Notify::new()), guest: Arc::new(Mutex::new(None)) };
        let task = Task { uds, ctl: ctl.clone(), events, ready: ready_tx, sandbox, last_identity: None, sweep };
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

    /// The guest's version and capabilities from its last hello, if one arrived.
    pub fn guest(&self) -> Option<nest_protocol::gateway::GuestInfo> {
        self.guest.lock().expect("guest info").clone()
    }

    /// Send a request and wait for its reply. Errors if not connected.
    pub async fn request(&self, body: ControlBody) -> io::Result<ControlBody> {
        let (tx, rx) = oneshot::channel();
        self.reqs.send(Req { body, reply: tx }).map_err(|_| io::Error::other("guest control task ended"))?;
        tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest request timed out"))?
            .map_err(|_| io::Error::other("guest control connection dropped"))?
    }

    /// Add an agent slot (persisted for reconfiguration after reconnects). A detach still owed for
    /// the agent goes first, as the guest would have seen it, so the newer attachment starts clean;
    /// if that detach fails, so does the attach, and the detach stays owed.
    pub async fn attach(&self, slot: AgentSlot) -> io::Result<()> {
        let owed = self.cfg.lock().expect("guest cfg").detaches.owed(&slot.agent_id);
        if let Some(sent) = owed {
            self.send_detach(&slot.agent_id, sent).await?;
        }
        {
            let mut c = self.cfg.lock().expect("guest cfg");
            c.slots.retain(|s| s.agent_id != slot.agent_id);
            c.slots.push(slot.clone());
        }
        expect_ok(self.request(ControlBody::AgentAttach { slot }).await?)
    }

    /// Drop an agent's slot from the set `configure` sends, without telling the guest (a slot
    /// that never took, or one nestd no longer has). One whose detach is owed stays until the guest
    /// confirms the detach: dropped from `configure` first, its processes would be orphaned.
    pub fn forget_slot(&self, agent: &AgentId) {
        let mut c = self.cfg.lock().expect("guest cfg");
        if c.detaches.owed(agent).is_none() {
            c.slots.retain(|s| &s.agent_id != agent);
        }
    }

    /// The proxy ports of slots kept only for an owed detach, but `attaching`'s own (its attach
    /// sends the detach first and replaces the slot): a new slot must not take one, or a
    /// `configure` would carry two agents on one port.
    pub fn owed_ports(&self, attaching: &AgentId) -> Vec<u16> {
        let c = self.cfg.lock().expect("guest cfg");
        c.slots.iter().filter(|s| &s.agent_id != attaching && c.detaches.owed(&s.agent_id).is_some()).map(|s| s.proxy_port).collect()
    }

    /// Detach an agent in the guest (it leaves the guest's table; with `kill_processes` its tasks
    /// are stopped and its processes killed). Ok only once the guest confirmed it. Until then it is owed: the agent stays in
    /// every `configure`, the connection sends the detach after each one, and an `agent_detach`
    /// asked again or an attach of the agent sends it first. A guest that isn't connected gets it
    /// on its next `configure`; this answers at once that it didn't arrive.
    pub async fn detach(&self, agent: &AgentId, kill_processes: bool) -> io::Result<()> {
        // Asked, and `ready` read, under the `cfg` lock: the handshake sets `ready` under it only
        // once it has sent every ask (see `serve`).
        let (sent, ready) = {
            let mut c = self.cfg.lock().expect("guest cfg");
            (c.detaches.ask(agent.clone(), kill_processes), *self.ready.borrow())
        };
        if !ready {
            return Err(io::Error::new(io::ErrorKind::NotConnected, "the guest is not connected: the detach is sent after its next configure"));
        }
        self.send_detach(agent, sent).await
    }

    /// Send the owed detach `sent`, and settle it on the guest's confirmation.
    async fn send_detach(&self, agent: &AgentId, sent: Owed) -> io::Result<()> {
        expect_ok(self.request(ControlBody::AgentDetach { agent_id: agent.clone(), kill_processes: sent.kill }).await?)?;
        self.detach_confirmed(agent, sent);
        Ok(())
    }

    /// Whether a detach of `agent` is still owed to the guest (asked, not confirmed).
    pub fn owes_detach(&self, agent: &AgentId) -> bool {
        self.cfg.lock().expect("guest cfg").detaches.owed(agent).is_some()
    }

    /// The guest confirmed the detach sent for `sent`: once that settles what is owed, the agent's
    /// slot leaves the `configure` set.
    fn detach_confirmed(&self, agent: &AgentId, sent: Owed) {
        let mut c = self.cfg.lock().expect("guest cfg");
        if c.detaches.confirmed(agent, sent) {
            c.slots.retain(|s| &s.agent_id != agent);
        }
    }

    /// `sync` and optionally `drop_caches`. The deprecated `fsfreeze` list stays empty, so it
    /// isn't sent; every guest image defaults it.
    pub async fn prepare_snapshot(&self, drop_caches: bool) -> io::Result<()> {
        expect_ok(self.request(ControlBody::PrepareSnapshot { drop_caches, fsfreeze: Vec::new() }).await?)
    }

    pub async fn thaw(&self) -> io::Result<()> {
        expect_ok(self.request(ControlBody::Thaw {}).await?)
    }

    /// Arrange for `resume` (clock + entropy, optional fork identity) after the next hello.
    pub fn expect_resume(&self, fork: Option<ForkIdentity>) {
        *self.pending_resume.lock().expect("resume") = Some(fork);
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
    /// How often owed detaches go again to a connected guest.
    sweep: Duration,
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
            while let Ok(Req { reply, .. }) = reqs.try_recv() {
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
            let _ = write_json(&mut c.wr, &e).await;
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
        // 3. the detaches still owed: the agents are in the configure just sent, so the guest has
        // their tasks to stop. A refusal leaves one owed (logged); a lost connection ends this one.
        // A detach asked meanwhile is sent too: ready is set under the `cfg` lock only once a pass
        // finds no ask this handshake hasn't sent, and `detach()` asks and reads `ready` under the
        // same lock, so every ask is either sent here or sent by `detach()` itself.
        let guest = nest_protocol::gateway::GuestInfo { protocol_version, capabilities };
        *self.ctl.guest.lock().expect("guest info") = Some(guest.clone());
        let mut sent_here: std::collections::BTreeSet<(AgentId, u64)> = std::collections::BTreeSet::new();
        loop {
            let unsent: Vec<(AgentId, Owed)> = {
                let cfg = self.ctl.cfg.lock().expect("guest cfg");
                let unsent: Vec<_> = cfg.detaches.all().filter(|(a, o)| !sent_here.contains(&((*a).clone(), o.ask))).map(|(a, o)| (a.clone(), o)).collect();
                if unsent.is_empty() {
                    self.ready.send_replace(true);
                    break;
                }
                unsent
            };
            for (agent, sent) in unsent {
                sent_here.insert((agent.clone(), sent.ask));
                match self.call(c, ControlBody::AgentDetach { agent_id: agent.clone(), kill_processes: sent.kill }).await? {
                    ControlBody::Ok {} => self.ctl.detach_confirmed(&agent, sent),
                    other => tracing::warn!(sandbox = %self.sandbox, %agent, reply = ?other, "the guest refused an owed detach; the sweep sends it again"),
                }
            }
        }
        let _ = self.events.send((self.sandbox.clone(), GuestEvent::Ready { resumed, guest }));

        // 4. steady state; every `sweep`, the detaches still owed (refused, timed out) go again.
        let mut sweep = tokio::time::interval_at(tokio::time::Instant::now() + self.sweep, self.sweep);
        loop {
            tokio::select! {
                _ = sweep.tick() => {
                    let owed: Vec<(AgentId, Owed)> = self.ctl.cfg.lock().expect("guest cfg").detaches.all().map(|(a, o)| (a.clone(), o)).collect();
                    for (agent, sent) in owed {
                        if c.sweeps.values().any(|(a, o)| *a == agent && *o == sent) {
                            continue; // in flight
                        }
                        let id = c.send(ControlBody::AgentDetach { agent_id: agent.clone(), kill_processes: sent.kill }).await?;
                        c.sweeps.insert(id, (agent, sent));
                    }
                }
                f = c.rd.next_json() => {
                    let Some(f) = f? else { return Ok(()) };
                    self.route(c, f);
                }
                req = reqs.recv() => {
                    let Some(Req { body, reply }) = req else { return Ok(()) };
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
                    write_json(&mut c.wr, &ControlFrame { id: None, reply_to: Some(id), body: ControlBody::CliResult { result } }).await?;
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
            } else if let Some((agent, sent)) = c.sweeps.remove(&r) {
                match cf.body {
                    ControlBody::Ok {} => self.ctl.detach_confirmed(&agent, sent),
                    other => tracing::warn!(sandbox = %self.sandbox, %agent, reply = ?other, "the guest refused an owed detach; the sweep sends it again"),
                }
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
/// How often a connected guest is sent the detaches it still owes (refused, or timed out).
const OWED_SWEEP: Duration = Duration::from_secs(10);

/// One control connection: its reader, its writer, and the requests awaiting a reply.
struct Session {
    rd: FramedReader<tokio::net::unix::OwnedReadHalf>,
    wr: tokio::net::unix::OwnedWriteHalf,
    next_id: u64,
    pending: HashMap<u64, oneshot::Sender<io::Result<ControlBody>>>,
    /// Owed detaches the steady-state sweep sent, by request id, until their replies.
    sweeps: HashMap<u64, (AgentId, Owed)>,
    /// Where a relayed CLI command's answer goes, to be written back by the session.
    cli_tx: mpsc::UnboundedSender<(u64, CliResult)>,
}

impl Session {
    fn new(conn: Conn, cli_tx: mpsc::UnboundedSender<(u64, CliResult)>) -> Session {
        // Any bytes buffered after the handshake line belong to the frame stream.
        let buffered = conn.buffer().to_vec();
        let (rd, wr) = conn.into_inner().into_split();
        Session { rd: FramedReader::with_buffered(rd, &buffered), wr, next_id: 1, pending: HashMap::new(), sweeps: HashMap::new(), cli_tx }
    }

    /// The next control frame within `limit`; the end of the stream is an error.
    async fn next_within(&mut self, limit: Duration) -> io::Result<ControlFrame> {
        tokio::time::timeout(limit, self.rd.next_json())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest control read timed out"))??
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "guest closed control connection"))
    }

    /// Send a request; its id.
    async fn send(&mut self, body: ControlBody) -> io::Result<u64> {
        let id = self.next_id;
        self.next_id += 1;
        write_json(&mut self.wr, &ControlFrame { id: Some(id), reply_to: None, body }).await?;
        Ok(id)
    }
}

/// 32 lowercase hex chars for a forked guest's `/etc/machine-id`.
pub fn new_machine_id() -> String {
    random_hex(16)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use nest_protocol::guest::frame::{self, Decoder};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use std::path::Path;
    use tokio::net::UnixListener;

    /// In-process fake guest agent: listens on `<dir>/1024.sock`, speaks the control protocol,
    /// records every host request it gets.
    pub struct FakeGuest {
        pub seen: Arc<Mutex<Vec<ControlBody>>>,
        pub task: tokio::task::JoinHandle<()>,
        /// The next this many `agent_detach` requests are refused.
        pub refuse_detaches: Arc<std::sync::atomic::AtomicUsize>,
        /// Each `agent_detach` is answered this many ms late.
        pub detach_delay_ms: Arc<std::sync::atomic::AtomicU64>,
    }

    impl FakeGuest {
        pub fn start(guest_dir: &Path, boot_id: &str) -> FakeGuest {
            std::fs::create_dir_all(guest_dir).unwrap();
            let listener = UnixListener::bind(guest_dir.join("1024.sock")).unwrap();
            let seen = Arc::new(Mutex::new(vec![]));
            let seen2 = seen.clone();
            let refuse_detaches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let refuse = refuse_detaches.clone();
            let detach_delay_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let delay = detach_delay_ms.clone();
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
                            if matches!(cf.body, ControlBody::AgentDetach { .. }) {
                                let ms = delay.load(std::sync::atomic::Ordering::SeqCst);
                                tokio::time::sleep(Duration::from_millis(ms)).await;
                            }
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
                                ControlBody::AgentDetach { .. }
                                    if refuse.fetch_update(std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() =>
                                {
                                    ControlBody::Error { error: error("internal", "detach refused", true) }
                                }
                                _ => ControlBody::Ok {},
                            };
                            let r = ControlFrame { id: None, reply_to: cf.id, body: reply };
                            if s.write_all(&frame::encode_json(&r).unwrap()).await.is_err() { break 'conn; }
                        }
                    }
                }
            });
            FakeGuest { seen, task, refuse_detaches, detach_delay_ms }
        }
    }

    fn slot(agent: &str) -> AgentSlot {
        AgentSlot { agent_id: AgentId(agent.into()), proxy_port: 3128, cwd: "/workspace".into(), env: Default::default(), memory_max_bytes: None }
    }

    fn configured_agents(seen: &[ControlBody]) -> Vec<Vec<String>> {
        seen.iter().filter_map(|b| match b { ControlBody::Configure { agents, .. } => Some(agents.iter().map(|a| a.agent_id.0.clone()).collect()), _ => None }).collect()
    }

    fn detaches(seen: &[ControlBody]) -> Vec<(String, bool)> {
        seen.iter().filter_map(|b| match b { ControlBody::AgentDetach { agent_id, kill_processes } => Some((agent_id.0.clone(), *kill_processes)), _ => None }).collect()
    }

    /// Audit G-B2: a detach asked while the guest isn't connected used to answer `ok` and send
    /// nothing; the next `configure` only dropped the agent from the guest's table, so its processes
    /// ran on. Now it answers that the detach didn't arrive, and it is owed: the agent stays in the
    /// next `configure` (the guest still has its tasks to stop), the detach follows it, and only the
    /// guest's confirmation lets the slot go.
    #[tokio::test]
    async fn a_detach_asked_while_disconnected_reaches_the_guest_when_it_connects() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        std::fs::create_dir_all(&guest_dir).unwrap();
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, _erx) = mpsc::unbounded_channel();
        let agent = AgentId("agt_1".into());
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(3), "sbx-1".into(), vec![slot("agt_1")], etx);
        let e = ctl.detach(&agent, true).await.unwrap_err();
        assert!(e.to_string().contains("sent after its next configure"), "{e}");
        assert!(ctl.owes_detach(&agent));
        ctl.forget_slot(&agent);
        assert_eq!(ctl.cfg.lock().unwrap().slots.len(), 1, "an owed slot is never forgotten before its detach");
        // The guest comes: configured with the agent, then the kill, before it is ready.
        let fake = FakeGuest::start(&guest_dir, "boot-1");
        ctl.wait_ready(Duration::from_secs(5)).await.unwrap();
        let seen = fake.seen.lock().unwrap().clone();
        assert_eq!(configured_agents(&seen), [vec!["agt_1".to_string()]], "{seen:?}");
        assert_eq!(detaches(&seen), [("agt_1".to_string(), true)], "{seen:?}");
        assert!(!ctl.owes_detach(&agent), "confirmed");
        assert!(ctl.cfg.lock().unwrap().slots.is_empty(), "confirmed: out of configure");
        // Connected, a detach goes at once and is ok once confirmed.
        let other = AgentId("agt_2".into());
        ctl.cfg.lock().unwrap().slots.push(slot("agt_2"));
        ctl.detach(&other, false).await.unwrap();
        assert_eq!(detaches(&fake.seen.lock().unwrap()).last(), Some(&("agt_2".to_string(), false)));
        assert!(!ctl.owes_detach(&other));
        ctl.shutdown();
    }

    /// A detach the guest refuses stays owed and the agent stays in `configure`; the connection's
    /// sweep sends it again while the guest stays connected (no reconnect needed), and once
    /// confirmed the agent leaves `configure`.
    #[tokio::test]
    async fn a_refused_detach_is_sent_again_while_connected() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        let fake = FakeGuest::start(&guest_dir, "boot-1");
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, _erx) = mpsc::unbounded_channel();
        let agent = AgentId("agt_1".into());
        let ctl = GuestCtl::spawn_sweeping(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(3), "sbx-1".into(), vec![slot("agt_1")], etx, Duration::from_millis(100));
        ctl.wait_ready(Duration::from_secs(5)).await.unwrap();
        fake.refuse_detaches.store(2, std::sync::atomic::Ordering::SeqCst);
        assert!(ctl.detach(&agent, true).await.is_err(), "refused: not ok");
        assert!(ctl.owes_detach(&agent));
        assert!(ctl.cfg.lock().unwrap().slots.iter().any(|s| s.agent_id == agent), "kept for the next configure");
        let mut tries = 0;
        while ctl.owes_detach(&agent) && tries < 250 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tries += 1;
        }
        assert!(!ctl.owes_detach(&agent), "the sweep delivered it");
        let seen = fake.seen.lock().unwrap().clone();
        assert_eq!(configured_agents(&seen).len(), 1, "no reconnect: {seen:?}");
        assert_eq!(detaches(&seen), vec![("agt_1".to_string(), true); 3], "refused twice, then taken");
        assert!(ctl.cfg.lock().unwrap().slots.is_empty(), "confirmed: out of configure");
        ctl.shutdown();
    }

    /// A detach asked while the handshake is still sending the owed ones (not ready yet) goes out
    /// in that same handshake, before the guest is ready: it is never left for a later sweep.
    #[tokio::test]
    async fn a_detach_asked_during_the_handshake_is_sent_before_ready() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        std::fs::create_dir_all(&guest_dir).unwrap();
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, _erx) = mpsc::unbounded_channel();
        let (a, b) = (AgentId("agt_a".into()), AgentId("agt_b".into()));
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(3), "sbx-1".into(), vec![slot("agt_a"), slot("agt_b")], etx);
        assert!(ctl.detach(&a, true).await.is_err(), "not connected");
        let fake = FakeGuest::start(&guest_dir, "boot-1");
        fake.detach_delay_ms.store(150, std::sync::atomic::Ordering::SeqCst);
        // Once the handshake is sending a's detach (slowly answered), b's is asked.
        let mut tries = 0;
        while detaches(&fake.seen.lock().unwrap()).is_empty() && tries < 250 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            tries += 1;
        }
        assert!(!*ctl.ready.borrow(), "still in the handshake");
        assert!(ctl.detach(&b, false).await.is_err(), "not ready yet");
        ctl.wait_ready(Duration::from_secs(5)).await.unwrap();
        let seen = fake.seen.lock().unwrap().clone();
        assert_eq!(detaches(&seen), [("agt_a".to_string(), true), ("agt_b".to_string(), false)], "b went in the handshake: {seen:?}");
        assert!(!ctl.owes_detach(&a) && !ctl.owes_detach(&b));
        ctl.shutdown();
    }

    /// An attach of an agent whose detach is owed sends that detach first (the newer attachment
    /// starts clean, its kill done); if the guest refuses it, the attach fails and it stays owed.
    #[tokio::test]
    async fn an_attach_sends_an_owed_detach_first() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        let fake = FakeGuest::start(&guest_dir, "boot-1");
        let emu = vsock::Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let (etx, _erx) = mpsc::unbounded_channel();
        let agent = AgentId("agt_1".into());
        let ctl = GuestCtl::spawn(emu.path.clone(), SandboxId("sbx_1".into()), Epoch(3), "sbx-1".into(), vec![slot("agt_1")], etx);
        ctl.wait_ready(Duration::from_secs(5)).await.unwrap();
        fake.refuse_detaches.store(2, std::sync::atomic::Ordering::SeqCst);
        assert!(ctl.detach(&agent, true).await.is_err());
        assert!(ctl.attach(slot("agt_1")).await.is_err(), "its owed detach was refused: the attach fails");
        assert!(ctl.owes_detach(&agent));
        ctl.attach(slot("agt_1")).await.unwrap();
        assert!(!ctl.owes_detach(&agent));
        let seen = fake.seen.lock().unwrap().clone();
        let tail: Vec<&str> = seen
            .iter()
            .filter_map(|b| match b {
                ControlBody::AgentDetach { .. } => Some("detach"),
                ControlBody::AgentAttach { .. } => Some("attach"),
                _ => None,
            })
            .collect();
        assert_eq!(tail, ["detach", "detach", "detach", "attach"], "the kill goes before the attach: {seen:?}");
        assert_eq!(detaches(&seen).last(), Some(&("agt_1".to_string(), true)));
        assert_eq!(ctl.cfg.lock().unwrap().slots.len(), 1, "the new attachment's slot");
        ctl.shutdown();
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
    /// sandbox isn't reported ready, and the next connection asks again.
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
