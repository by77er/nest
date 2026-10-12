//! Host side of the hybrid-vsock transport (`docs/interfaces/host-guest/`).
//!
//! [`connect`] dials a VM's vsock unix socket and performs the `CONNECT <port>` handshake. The
//! same code talks to Firecracker and to the [`Emulator`], which the `process` driver uses to
//! bridge `CONNECT <port>` to a guest agent listening on `<dir>/<port>.sock`.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nest_protocol::guest::handshake;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::task::JoinHandle;

/// Connect to `port` through the VM's hybrid-vsock socket. Returns the stream positioned after
/// the `OK` line. Any bytes the peer sent after `OK` stay buffered in the returned reader.
pub async fn connect(uds: &Path, port: u32) -> io::Result<BufReader<UnixStream>> {
    let mut s = UnixStream::connect(uds).await?;
    s.write_all(handshake::connect_line(port).as_bytes()).await?;
    let mut r = BufReader::new(s);
    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(5), r.read_line(&mut line))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "vsock handshake timed out"))??;
    if n == 0 {
        // Firecracker closes the socket when nothing listens on the guest port.
        return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("guest not listening on vsock port {port}")));
    }
    handshake::parse_ok_line(&line)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("bad vsock handshake reply {line:?}")))?;
    Ok(r)
}

/// Unix-socket stand-in for Firecracker's hybrid vsock (test transport, no KVM required).
pub struct Emulator {
    task: JoinHandle<()>,
    pub path: PathBuf,
}

impl Emulator {
    /// Listen on `path`; bridge each `CONNECT <port>` to `<guest_dir>/<port>.sock`.
    pub fn start(path: &Path, guest_dir: &Path) -> io::Result<Self> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        let guest_dir = guest_dir.to_path_buf();
        let task = tokio::spawn(async move {
            let mut next_port: u32 = 1 << 30;
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                next_port = next_port.wrapping_add(1);
                let guest_dir = guest_dir.clone();
                let assigned = next_port;
                tokio::spawn(async move {
                    if let Err(e) = bridge(stream, &guest_dir, assigned).await {
                        tracing::debug!(error = %e, "vsock emulator connection ended");
                    }
                });
            }
        });
        Ok(Self { task, path: path.to_path_buf() })
    }
}

impl Drop for Emulator {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn bridge(stream: UnixStream, guest_dir: &Path, assigned: u32) -> io::Result<()> {
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line).await?;
    let port = handshake::parse_connect_line(&line)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("bad CONNECT line {line:?}")))?;
    // Like Firecracker: close without a reply when nothing listens on the port.
    let guest = UnixStream::connect(guest_dir.join(format!("{port}.sock"))).await?;
    let pending = r.buffer().to_vec();
    let mut host = r.into_inner();
    host.write_all(handshake::ok_line(assigned).as_bytes()).await?;
    let (mut gr, mut gw) = guest.into_split();
    if !pending.is_empty() {
        gw.write_all(&pending).await?;
    }
    let (mut hr, mut hw) = host.into_split();
    let up = async {
        let r = tokio::io::copy(&mut hr, &mut gw).await;
        let _ = gw.shutdown().await;
        r
    };
    let down = async {
        let r = tokio::io::copy(&mut gr, &mut hw).await;
        let _ = hw.shutdown().await;
        r
    };
    let _ = tokio::join!(up, down);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn emulator_bridges_connect_to_port_socket() {
        let dir = tempfile::tempdir().unwrap();
        let guest_dir = dir.path().join("guest");
        std::fs::create_dir_all(&guest_dir).unwrap();
        let echo = UnixListener::bind(guest_dir.join("1025.sock")).unwrap();
        tokio::spawn(async move {
            let (mut s, _) = echo.accept().await.unwrap();
            let mut buf = [0u8; 5];
            s.read_exact(&mut buf).await.unwrap();
            s.write_all(&buf).await.unwrap();
        });
        let emu = Emulator::start(&dir.path().join("vsock.sock"), &guest_dir).unwrap();
        let mut c = connect(&emu.path, 1025).await.unwrap();
        c.get_mut().write_all(b"hello").await.unwrap();
        let mut buf = [0u8; 5];
        c.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");

        // Nothing listening on 9999: connection closes, mapped to ConnectionRefused.
        let err = connect(&emu.path, 9999).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused);
    }
}
