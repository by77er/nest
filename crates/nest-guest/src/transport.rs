//! Listeners for the guest's vsock ports, and the unix-socket emulation used without KVM.
//!
//! In `vsock` mode the guest binds `AF_VSOCK` ports. In `unix:<dir>` mode it binds
//! `<dir>/<port>.sock` instead, and [`emulator`] plays Firecracker's role: one unix socket that
//! speaks `CONNECT <port>\n` / `OK <n>\n` and bridges to the per-port socket.

use std::io;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixListener;

/// Any bidirectional byte stream (vsock or unix).
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Stream for T {}

pub type Conn = Box<dyn Stream>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListenSpec {
    Vsock,
    /// Directory holding `<port>.sock` files.
    Unix(PathBuf),
}

impl ListenSpec {
    pub fn parse(s: &str) -> Option<Self> {
        if s == "vsock" {
            Some(ListenSpec::Vsock)
        } else {
            s.strip_prefix("unix:").map(|d| ListenSpec::Unix(PathBuf::from(d)))
        }
    }
}

pub enum PortListener {
    Vsock(tokio_vsock::VsockListener),
    Unix(UnixListener),
}

impl PortListener {
    pub fn bind(spec: &ListenSpec, port: u32) -> io::Result<Self> {
        match spec {
            ListenSpec::Vsock => {
                let addr = tokio_vsock::VsockAddr::new(tokio_vsock::VMADDR_CID_ANY, port);
                Ok(PortListener::Vsock(tokio_vsock::VsockListener::bind(addr)?))
            }
            ListenSpec::Unix(dir) => {
                std::fs::create_dir_all(dir)?;
                let path = port_socket(dir, port);
                let _ = std::fs::remove_file(&path);
                Ok(PortListener::Unix(UnixListener::bind(path)?))
            }
        }
    }

    pub async fn accept(&self) -> io::Result<Conn> {
        match self {
            PortListener::Vsock(l) => loop {
                let (s, peer) = l.accept().await?;
                // Only the host (CID 2) may connect. With vsock loopback in the guest kernel, a
                // process inside the sandbox could otherwise reach control/hands/ingress.
                if peer.cid() == tokio_vsock::VMADDR_CID_HOST {
                    return Ok(Box::new(s));
                }
                tracing::warn!(cid = peer.cid(), "refused vsock connection from a non-host peer");
            },
            PortListener::Unix(l) => Ok(Box::new(l.accept().await?.0)),
        }
    }
}

/// `<dir>/<port>.sock`
pub fn port_socket(dir: &Path, port: u32) -> PathBuf {
    dir.join(format!("{port}.sock"))
}

/// Firecracker's host-side hybrid-vsock socket, emulated on plain unix sockets.
pub mod emulator {
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    use nest_protocol::guest::handshake;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};
    use tokio::task::JoinHandle;

    /// Accepts on one socket and bridges `CONNECT <port>` to `<guest_dir>/<port>.sock`.
    /// Like Firecracker, it closes the connection when nothing listens on the port.
    pub struct Emulator {
        pub socket: PathBuf,
        task: JoinHandle<()>,
    }

    impl Emulator {
        pub fn start(socket: &Path, guest_dir: &Path) -> io::Result<Emulator> {
            let _ = std::fs::remove_file(socket);
            let listener = UnixListener::bind(socket)?;
            let guest_dir = guest_dir.to_path_buf();
            let next = Arc::new(AtomicU32::new(1 << 30));
            let task = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let dir = guest_dir.clone();
                    let next = next.clone();
                    tokio::spawn(async move {
                        let _ = bridge(stream, &dir, &next).await;
                    });
                }
            });
            Ok(Emulator { socket: socket.to_path_buf(), task })
        }
    }

    impl Drop for Emulator {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn bridge(mut host: UnixStream, dir: &Path, next: &AtomicU32) -> io::Result<()> {
        let line = read_line(&mut host).await?;
        let Some(port) = handshake::parse_connect_line(&line) else { return Ok(()) };
        let Ok(mut guest) = UnixStream::connect(super::port_socket(dir, port)).await else {
            return Ok(()); // nothing listening: Firecracker just closes
        };
        let assigned = next.fetch_add(1, Ordering::Relaxed);
        host.write_all(handshake::ok_line(assigned).as_bytes()).await?;
        tokio::io::copy_bidirectional(&mut host, &mut guest).await?;
        Ok(())
    }

    /// Read one `\n`-terminated line byte by byte so nothing past it is consumed.
    pub async fn read_line(s: &mut UnixStream) -> io::Result<String> {
        let mut line = Vec::new();
        loop {
            let b = s.read_u8().await?;
            if b == b'\n' {
                break;
            }
            line.push(b);
            if line.len() > 64 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "handshake line too long"));
            }
        }
        String::from_utf8(line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Host-side connect through a hybrid-vsock socket (real Firecracker or this emulator).
    pub async fn connect(socket: &Path, port: u32) -> io::Result<UnixStream> {
        let mut s = UnixStream::connect(socket).await?;
        s.write_all(handshake::connect_line(port).as_bytes()).await?;
        let line = read_line(&mut s).await?;
        handshake::parse_ok_line(&line)
            .ok_or_else(|| io::Error::new(io::ErrorKind::ConnectionRefused, format!("bad handshake reply {line:?}")))?;
        Ok(s)
    }
}
