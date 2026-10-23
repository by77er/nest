//! Port watcher: listening TCP sockets from `/proc/net/tcp{,6}`, announced on change.

use std::collections::HashMap;
use std::sync::Arc;

use nest_protocol::guest::{ControlBody, ListeningPort, PortProto};

use crate::state::{Guest, now_ms};

const TCP_LISTEN: &str = "0A";

/// Current listening sockets, sorted by (port, proto, bind).
///
/// The socket table is read before the fd tables: a socket that is already `LISTEN` has had its
/// fd since `socket()`, so the owner scan that follows finds it. The other order reports a socket
/// that started listening between the two reads with no pid, then again with one a poll later.
pub fn scan() -> Vec<ListeningPort> {
    let mut listening = Vec::new();
    for (file, proto) in [("/proc/net/tcp", PortProto::Tcp), ("/proc/net/tcp6", PortProto::Tcp6)] {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        for line in text.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 || cols[3] != TCP_LISTEN {
                continue;
            }
            let Some((addr, port)) = cols[1].split_once(':') else { continue };
            let Ok(port) = u16::from_str_radix(port, 16) else { continue };
            listening.push((port, proto, bind_label(addr), cols[9].parse::<u64>().ok()));
        }
    }
    let inodes = socket_owners();
    let mut out = Vec::new();
    for (port, proto, bind, inode) in listening {
        let owner = inode.and_then(|i| inodes.get(&i));
        out.push(ListeningPort { port, proto, bind, pid: owner.map(|o| o.0), process: owner.map(|o| o.1.clone()) });
    }
    out.sort_by(|a, b| (a.port, a.proto as u8, &a.bind).cmp(&(b.port, b.proto as u8, &b.bind)));
    out.dedup();
    out
}

/// `loopback`, `any`, or the dotted / colon address.
fn bind_label(hex: &str) -> String {
    match hex.len() {
        8 => {
            let v = u32::from_str_radix(hex, 16).unwrap_or(0);
            let ip = std::net::Ipv4Addr::from(v.to_le_bytes());
            if ip.is_unspecified() {
                "any".into()
            } else if ip.is_loopback() {
                "loopback".into()
            } else {
                ip.to_string()
            }
        }
        32 => {
            let mut bytes = [0u8; 16];
            for (i, chunk) in hex.as_bytes().chunks(8).enumerate() {
                let word = u32::from_str_radix(std::str::from_utf8(chunk).unwrap_or("0"), 16).unwrap_or(0);
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
            }
            let ip = std::net::Ipv6Addr::from(bytes);
            if ip.is_unspecified() {
                "any".into()
            } else if ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()) {
                "loopback".into()
            } else {
                ip.to_string()
            }
        }
        _ => hex.into(),
    }
}

/// socket inode → (pid, comm), for processes whose fds we can see.
fn socket_owners() -> HashMap<u64, (u32, String)> {
    let mut map = HashMap::new();
    let Ok(procs) = std::fs::read_dir("/proc") else { return map };
    for p in procs.flatten() {
        let Some(pid) = p.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(fds) = std::fs::read_dir(p.path().join("fd")) else { continue };
        let mut comm = None;
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else { continue };
            let t = target.to_string_lossy();
            if let Some(inode) = t.strip_prefix("socket:[").and_then(|s| s.strip_suffix(']')).and_then(|s| s.parse().ok()) {
                let c = comm.get_or_insert_with(|| {
                    std::fs::read_to_string(p.path().join("comm")).map(|s| s.trim().to_string()).unwrap_or_default()
                });
                map.entry(inode).or_insert((pid, c.clone()));
            }
        }
    }
    map
}

/// Poll forever, emitting the full set whenever it changes.
pub async fn watch(guest: Arc<Guest>) {
    let mut last: Option<Vec<ListeningPort>> = None;
    loop {
        let now = tokio::task::spawn_blocking(scan).await.unwrap_or_default();
        if last.as_ref() != Some(&now) {
            *guest.ports.lock().unwrap() = now.clone();
            guest.emit(ControlBody::Ports { listening: now.clone(), ts_ms: now_ms() });
            last = Some(now);
        }
        tokio::time::sleep(guest.config.port_poll).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(bind_label("0100007F"), "loopback");
        assert_eq!(bind_label("00000000"), "any");
        assert_eq!(bind_label("020010AC"), "172.16.0.2");
        assert_eq!(bind_label("00000000000000000000000000000000"), "any");
        assert_eq!(bind_label("00000000000000000000000001000000"), "loopback");
    }
}
