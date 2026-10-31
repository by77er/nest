//! Ingress (port 10000): raw TCP splice to an in-guest port, or a framed PTY.

use std::collections::BTreeMap;
use std::io;
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::sync::Arc;
use std::time::Duration;

use nest_protocol::guest::frame::Kind;
use nest_protocol::guest::framed::{self, FramedReader, write_json};
use nest_protocol::guest::{IngressRequest, IngressResponse, PtyControl, error_code};
use nest_protocol::model::AgentId;
use nix::fcntl::OFlag;
use nix::pty::{grantpt, posix_openpt, ptsname_r, unlockpt};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncWriteExt, ReadHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::debug;

use crate::exec::{Leaf, PreExec};
use crate::framed::{err, parse_json};
use crate::state::{Gate, Guest};
use crate::transport::Conn;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn serve(guest: Arc<Guest>, conn: Conn) {
    let mut reader = FramedReader::new(conn);
    let req: IngressRequest = match reader.next().await {
        Ok(Some(f)) => match parse_json(&f) {
            Ok(r) => r,
            Err(e) => {
                let (mut conn, _) = reader.into_parts();
                let _ = write_json(&mut conn, &IngressResponse::Rejected { error: e }).await;
                return;
            }
        },
        _ => return,
    };
    match req {
        IngressRequest::Tcp { port } => tcp(reader, port).await,
        IngressRequest::Pty { agent_id, cols, rows, command, cwd, env } => {
            let (mut conn, rest) = reader.into_parts();
            let admitted = guest.inner.lock().unwrap().admit(Gate::Pty).map(|_| ());
            if let Err(error) = admitted {
                let _ = write_json(&mut conn, &IngressResponse::Rejected { error }).await;
                return;
            }
            if let Err(e) = pty(&guest, conn, rest, agent_id, cols, rows, command, cwd, env).await {
                debug!(error = %e, "pty session ended with error");
            }
        }
    }
}

async fn tcp(reader: FramedReader<Conn>, port: u16) {
    let mut target = None;
    for addr in [SocketAddr::from(([127, 0, 0, 1], port)), SocketAddr::from(([172, 16, 0, 2], port)), SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))] {
        if let Ok(Ok(s)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            target = Some((s, addr));
            break;
        }
    }
    let (mut conn, rest) = reader.into_parts();
    let Some((mut stream, addr)) = target else {
        let _ = write_json(
            &mut conn,
            &IngressResponse::Rejected {
                error: err(error_code::CONNECT_REFUSED, format!("nothing is listening on port {port}"), true),
            },
        )
        .await;
        return;
    };
    let accepted = IngressResponse::Accepted { connected: Some(addr.to_string()), pid: None };
    if write_json(&mut conn, &accepted).await.is_err() {
        return;
    }
    if !rest.is_empty() && stream.write_all(&rest).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut conn, &mut stream).await;
}

/// Master side of a PTY as an async fd.
struct Master(AsyncFd<OwnedFd>);

impl Master {
    fn new(fd: OwnedFd) -> io::Result<Self> {
        let raw = fd.as_raw_fd();
        // SAFETY: valid fd we own.
        unsafe {
            let flags = libc::fcntl(raw, libc::F_GETFL);
            libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        // SAFETY: the AsyncFd takes ownership of `fd`, an `OwnedFd`: the descriptor stays open and
        // refers to the same PTY master until the AsyncFd drops it (RUSTSEC-2026-0386).
        Ok(Master(unsafe { AsyncFd::register(fd) }.map_err(io::Error::from)?))
    }

    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut guard = self.0.readable().await?;
            match guard.try_io(|fd| {
                // SAFETY: buf is valid for writes of buf.len() bytes.
                let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
            }) {
                Ok(Ok(n)) => return Ok(n),
                // EIO: the slave side is gone (child exited).
                Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Ok(0),
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
    }

    async fn write_all(&self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            let mut guard = self.0.writable().await?;
            match guard.try_io(|fd| {
                // SAFETY: data is valid for reads.
                let n = unsafe { libc::write(fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
                if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
            }) {
                Ok(Ok(n)) => data = &data[n..],
                Ok(Err(e)) => return Err(e),
                Err(_would_block) => continue,
            }
        }
        Ok(())
    }

    fn raw(&self) -> RawFd {
        self.0.get_ref().as_raw_fd()
    }
}

/// A PTY pair whose fds are close-on-exec from the start: any process the guest spawns
/// meanwhile (a concurrent Bash or task) would otherwise inherit the slave and keep the terminal
/// open after the session's shell exits, so the session would never end.
fn open_pty(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let master = posix_openpt(OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC)?;
    grantpt(&master)?;
    unlockpt(&master)?;
    let name = ptsname_r(&master)?;
    let slave = nix::fcntl::open(name.as_str(), OFlag::O_RDWR | OFlag::O_NOCTTY | OFlag::O_CLOEXEC, nix::sys::stat::Mode::empty())?;
    let master = OwnedFd::from(master);
    set_winsize(master.as_raw_fd(), cols, rows);
    Ok((master, slave))
}

fn set_winsize(fd: RawFd, cols: u16, rows: u16) {
    let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: TIOCSWINSZ with a valid winsize pointer.
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
    }
}

fn signal_by_name(name: &str) -> Option<Signal> {
    let n = name.trim_start_matches("SIG");
    format!("SIG{n}").parse().ok()
}

#[allow(clippy::too_many_arguments)]
async fn pty(
    guest: &Arc<Guest>,
    conn: Conn,
    rest: Vec<u8>,
    agent_id: Option<AgentId>,
    cols: u16,
    rows: u16,
    command: Option<Vec<String>>,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
) -> io::Result<()> {
    let (rd, mut wr) = tokio::io::split(conn);
    // Agent context, if any.
    let (mut envs, agent_cwd) = match agent_id.as_ref().map(|a| guest.exec_ctx(a)) {
        Some(Ok(ctx)) => (ctx.env, Some(ctx.cwd)),
        Some(Err(error)) => return write_json(&mut wr, &IngressResponse::Rejected { error }).await,
        None => (crate::exec::base_env(guest.config.run_as), None),
    };
    if !envs.iter().any(|(k, _)| k == "TERM") {
        envs.push(("TERM".into(), "xterm-256color".into()));
    }
    for (k, v) in env {
        envs.retain(|(ek, _)| *ek != k);
        envs.push((k, v));
    }
    let argv = command.filter(|c| !c.is_empty()).unwrap_or_else(|| {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/bash".into());
        vec![shell, "-l".into()]
    });
    let dir = cwd
        .or(agent_cwd)
        .or_else(|| std::env::var("HOME").ok())
        .filter(|d| std::path::Path::new(d).is_dir())
        .unwrap_or_else(|| "/".into());
    let cgroup = agent_id.as_ref().and_then(|a| guest.cgroups.leaf(&a.0, "pty", &crate::state::random_hex(4)));

    let (master_fd, slave) = open_pty(cols, rows)?;
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).current_dir(&dir).env_clear().envs(envs);
    PreExec { tty: Some(slave.as_raw_fd()), cgroup: cgroup.clone(), fd3: None, run_as: guest.config.run_as }.apply_tokio(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let e = err(error_code::INTERNAL, format!("could not start {}: {e}", argv[0]), false);
            return write_json(&mut wr, &IngressResponse::Rejected { error: e }).await;
        }
    };
    drop(slave);
    let pid = child.id().unwrap_or(0);
    // The session's terminal leaf goes with it, however it ends.
    let leaf = Leaf { cgroup, pgid: Some(pid) };
    let session = async {
        let master = Arc::new(Master::new(master_fd)?);
        write_json(&mut wr, &IngressResponse::Accepted { connected: None, pid: Some(pid) }).await?;

        // Host → PTY.
        let (hangup_tx, mut hangup_rx) = mpsc::channel::<()>(1);
        let input = {
            let master = master.clone();
            tokio::spawn(async move { host_to_pty(rd, rest, master, pid).await; let _ = hangup_tx.send(()).await; })
        };

        // PTY → host, until the shell exits (EIO) or the host hangs up.
        let mut buf = vec![0u8; 16 * 1024];
        let mut hung_up = false;
        loop {
            tokio::select! {
                r = master.read(&mut buf) => match r {
                    Ok(0) | Err(_) => break,
                    Ok(n) => if framed::write(&mut wr, Kind::Data, &buf[..n]).await.is_err() { hung_up = true; break; },
                },
                _ = hangup_rx.recv() => { hung_up = true; break; }
            }
        }
        if hung_up {
            let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGHUP);
            input.abort();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            return Ok(());
        }
        let status = child.wait().await?;
        input.abort();
        let exit = PtyControl::Exit { code: status.code(), signal: status.signal() };
        write_json(&mut wr, &exit).await?;
        wr.shutdown().await
    };
    let ended = session.await;
    leaf.release();
    ended
}

async fn host_to_pty(rd: ReadHalf<Conn>, rest: Vec<u8>, master: Arc<Master>, pid: u32) {
    // Bytes already buffered past the request frame are framed data too.
    let mut reader = FramedReader::with_buffered(rd, &rest);
    loop {
        let Ok(Some(f)) = reader.next().await else { return };
        match f.kind {
            Kind::Data => {
                if master.write_all(&f.payload).await.is_err() {
                    return;
                }
            }
            Kind::Json => match parse_json::<PtyControl>(&f) {
                Ok(PtyControl::Resize { cols, rows }) => set_winsize(master.raw(), cols, rows),
                Ok(PtyControl::Signal { signal }) => {
                    if let Some(sig) = signal_by_name(&signal) {
                        // Foreground process group of the terminal, else the session leader's group.
                        // SAFETY: tcgetpgrp on a valid fd.
                        let fg = unsafe { libc::tcgetpgrp(master.raw()) };
                        let pg = if fg > 0 { fg } else { pid as i32 };
                        let _ = killpg(Pid::from_raw(pg), sig);
                    }
                }
                _ => {}
            },
        }
    }
}

