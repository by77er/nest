//! Per-sandbox network namespace (`docs/sandbox/networking/egress/steering/`).
//!
//! The netns has no uplink: only `tap0` (172.16.0.1/30) and listening sockets owned by nest-proxy.
//! nestd creates the netns in a helper thread (`unshare(CLONE_NEWNET)`), keeps an fd to it, and
//! runs every operation that must happen *inside* it (`ip`, `nft`, `socket/bind/listen`) on a
//! fresh thread that `setns`es into it first. Namespaces are per-thread, and child processes
//! spawned from that thread inherit it. A socket keeps the namespace it was created in.
//!
//! Everything here works unprivileged inside a user namespace (`unshare -rn`), which is how the
//! tests run.

use std::fs::File;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use nest_protocol::host::proxy::Transport;
use nix::sched::{CloneFlags, setns, unshare};
use socket2::{Domain, Protocol, Socket, Type};

/// Host-side address of the sandbox network (gateway, DNS, proxy).
pub const GATEWAY_IP: &str = "172.16.0.1";
/// Guest address (identical in every sandbox).
pub const GUEST_IP: &str = "172.16.0.2";
pub const TAP_NAME: &str = "tap0";

/// Explicit-proxy port range reserved for agent slots (`3128 + slot`).
pub const EXPLICIT_PORTS: (u16, u16) = (3128, 3191);
/// TCP-exception port range (`20000 + n`).
pub const TCP_EXCEPTION_PORTS: (u16, u16) = (20000, 20999);

pub struct Netns {
    fd: OwnedFd,
    /// Bind-mounted path (`/run/netns/ns-<id>`), when persisted for the Firecracker jailer.
    persisted: Option<PathBuf>,
}

impl Netns {
    /// Create a new, empty network namespace. If `persist` is set, bind-mount it there so other
    /// tools (`ip netns`, the jailer's `--netns`) can address it by path. Persisting needs
    /// `CAP_SYS_ADMIN` over the mount namespace.
    pub fn create(persist: Option<&Path>) -> io::Result<Netns> {
        let persist = persist.map(Path::to_path_buf);
        let (fd, persisted) = std::thread::spawn(move || -> io::Result<(OwnedFd, Option<PathBuf>)> {
            unshare(CloneFlags::CLONE_NEWNET).map_err(io::Error::from)?;
            let ns = File::open("/proc/thread-self/ns/net")?;
            let persisted = match persist {
                Some(p) => {
                    if let Some(dir) = p.parent() {
                        std::fs::create_dir_all(dir)?;
                    }
                    File::create(&p)?;
                    nix::mount::mount(
                        Some("/proc/thread-self/ns/net"),
                        &p,
                        None::<&str>,
                        nix::mount::MsFlags::MS_BIND,
                        None::<&str>,
                    )
                    .map_err(io::Error::from)?;
                    Some(p)
                }
                None => None,
            };
            Ok((ns.into(), persisted))
        })
        .join()
        .map_err(|_| io::Error::other("netns helper thread panicked"))??;
        Ok(Netns { fd, persisted })
    }

    /// Path usable by external tools, if persisted.
    pub fn path(&self) -> Option<&Path> {
        self.persisted.as_deref()
    }

    /// Run `f` on a fresh thread inside this namespace.
    pub fn run<F, R>(&self, f: F) -> io::Result<R>
    where
        F: FnOnce() -> io::Result<R> + Send,
        R: Send,
    {
        let fd = self.fd.as_fd();
        std::thread::scope(|s| {
            s.spawn(|| {
                setns(fd, CloneFlags::CLONE_NEWNET).map_err(io::Error::from)?;
                f()
            })
            .join()
            .map_err(|_| io::Error::other("netns worker thread panicked"))?
        })
    }

    /// Create `tap0` (172.16.0.1/30) and install the nft ruleset.
    pub fn configure(&self) -> io::Result<()> {
        self.configure_with(LinkSetup::Tap)
    }

    /// Like [`configure`](Self::configure), with the link supplied by a test (a veth peer named
    /// `tap0`, so the ruleset can be exercised without a VM).
    pub fn configure_with(&self, link: LinkSetup) -> io::Result<()> {
        self.run(|| {
            run_cmd("ip", &["link", "set", "lo", "up"])?;
            if let LinkSetup::Tap = link {
                run_cmd("ip", &["tuntap", "add", TAP_NAME, "mode", "tap"])?;
            }
            run_cmd("ip", &["addr", "add", &format!("{GATEWAY_IP}/30"), "dev", TAP_NAME])?;
            run_cmd("ip", &["link", "set", TAP_NAME, "up"])?;
            run_nft(&ruleset())
        })
    }

    /// Create a listening socket inside the namespace. TCP sockets are listening; UDP sockets
    /// are bound. Returned fds are blocking; the proxy switches them to non-blocking.
    pub fn bind(&self, transport: Transport, addr: SocketAddr) -> io::Result<OwnedFd> {
        self.run(move || bind_socket(transport, addr))
    }
}

impl Drop for Netns {
    fn drop(&mut self) {
        if let Some(p) = &self.persisted {
            let _ = nix::mount::umount2(p, nix::mount::MntFlags::MNT_DETACH);
            let _ = std::fs::remove_file(p);
        }
    }
}

pub enum LinkSetup {
    /// Production: create a tap device for Firecracker.
    Tap,
    /// Tests: an interface named `tap0` already exists in the namespace.
    Existing,
}

fn bind_socket(transport: Transport, addr: SocketAddr) -> io::Result<OwnedFd> {
    let (ty, proto) = match transport {
        Transport::Tcp => (Type::STREAM, Protocol::TCP),
        Transport::Udp => (Type::DGRAM, Protocol::UDP),
    };
    let s = Socket::new(Domain::for_address(addr), ty.cloexec(), Some(proto))?;
    s.set_reuse_address(true)?;
    // The gateway address exists as soon as tap0 is configured, but allow binding before the
    // link is up (FREEBIND) so ordering with the VM boot does not matter.
    s.set_freebind_v4(true)?;
    s.bind(&addr.into())?;
    if let Transport::Tcp = transport {
        s.listen(1024)?;
    }
    Ok(s.into())
}

/// The netns ruleset: guest HTTP(S) to anywhere is redirected to the transparent listeners, DNS
/// to anywhere goes to our resolver, only the gateway's listener ports are reachable, nothing is
/// forwarded.
pub fn ruleset() -> String {
    let (e0, e1) = EXPLICIT_PORTS;
    let (t0, t1) = TCP_EXCEPTION_PORTS;
    format!(
        "table inet nest {{
  chain prerouting {{
    type nat hook prerouting priority dstnat; policy accept;
    iifname \"{TAP_NAME}\" ip daddr != {GATEWAY_IP} tcp dport {{ 80, 443 }} redirect
    iifname \"{TAP_NAME}\" ip daddr != {GATEWAY_IP} udp dport 53 redirect
    iifname \"{TAP_NAME}\" ip daddr != {GATEWAY_IP} tcp dport 53 redirect
  }}
  chain input {{
    type filter hook input priority filter; policy drop;
    iif \"lo\" accept
    ct state established,related accept
    iifname \"{TAP_NAME}\" ip daddr {GATEWAY_IP} udp dport 53 accept
    iifname \"{TAP_NAME}\" ip daddr {GATEWAY_IP} tcp dport {{ 53, 80, 443, {e0}-{e1}, {t0}-{t1} }} accept
  }}
  chain forward {{
    type filter hook forward priority filter; policy drop;
  }}
}}
"
    )
}

fn run_cmd(prog: &str, args: &[&str]) -> io::Result<()> {
    let out = Command::new(prog).args(args).stdin(Stdio::null()).output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!(
            "{prog} {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

fn run_nft(rules: &str) -> io::Result<()> {
    let mut child = Command::new("nft").args(["-f", "-"]).stdin(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    child.stdin.take().expect("piped").write_all(rules.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!("nft -f: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

/// Test support: run the calling test inside a fresh user + network namespace by re-executing
/// the test binary under `unshare`. Returns `true` when already inside (run the test body),
/// `false` after the child ran (the caller returns). Panics if the child test failed, or if the
/// child didn't run `test_name` at all (a renamed test makes `--exact` match nothing, which
/// libtest reports as success). Without `unshare` it prints a `NEST-TEST-SKIP:` line and returns
/// `false`, unless `NEST_CI_REQUIRE_USERNS` is set, when it panics: CI never skips silently.
#[doc(hidden)]
pub fn reexec_in_userns(test_name: &str) -> bool {
    const MARK: &str = "NESTD_IN_USERNS";
    if let Some(ack) = std::env::var_os(MARK) {
        // A fresh network namespace starts with loopback down.
        let up = Command::new("ip").args(["link", "set", "lo", "up"]).status();
        assert!(matches!(up, Ok(s) if s.success()), "{test_name}: `ip link set lo up` failed: {up:?}");
        std::fs::write(&ack, test_name).expect("write the re-exec acknowledgement");
        return true;
    }
    let exe = std::env::current_exe().expect("current_exe");
    let ack = std::env::temp_dir().join(format!("nestd-userns-{}-{}", std::process::id(), test_name.replace(':', "_")));
    let _ = std::fs::remove_file(&ack);
    let status = Command::new("unshare")
        .args(["--user", "--map-root-user", "--net", "--mount", "--"])
        .arg(exe)
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env(MARK, &ack)
        .status();
    match status {
        Ok(s) if s.success() => {
            let ran = std::fs::read_to_string(&ack).ok();
            let _ = std::fs::remove_file(&ack);
            assert_eq!(
                ran.as_deref(),
                Some(test_name),
                "{test_name}: the re-executed test binary didn't run this test (renamed, or the name passed is wrong)"
            );
            false
        }
        Ok(s) => panic!("{test_name} failed inside user namespace: {s}"),
        Err(e) if std::env::var_os("NEST_CI_REQUIRE_USERNS").is_some() => {
            panic!("{test_name}: cannot run unshare ({e}), and NEST_CI_REQUIRE_USERNS forbids skipping")
        }
        Err(e) => {
            eprintln!("NEST-TEST-SKIP: {test_name}: cannot run unshare: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn ruleset_mentions_tap_and_ranges() {
        let r = ruleset();
        assert!(r.contains("iifname \"tap0\""));
        assert!(r.contains("3128-3191"));
        assert!(r.contains("policy drop"));
    }

    /// End to end inside a user namespace: netns + veth standing in for tap0 + nft + listeners.
    /// A "guest" namespace connects to an arbitrary IP on :443 and lands on our listener.
    #[test]
    fn netns_redirect_reaches_listener() {
        if !reexec_in_userns("net::tests::netns_redirect_reaches_listener") {
            return;
        }
        let sbx = Netns::create(None).expect("create sandbox netns");
        let guest = Netns::create(None).expect("create guest netns");
        // veth pair: `tap0` in the sandbox netns, `eth0` in the guest netns.
        sbx.run(|| run_cmd("ip", &["link", "add", TAP_NAME, "type", "veth", "peer", "name", "eth0"])).unwrap();
        // `ip link set … netns` takes a PID: park a process in the guest namespace.
        let mut holder = guest.run(|| Command::new("sleep").arg("60").spawn()).unwrap();
        let pid = holder.id().to_string();
        sbx.run(move || run_cmd("ip", &["link", "set", "eth0", "netns", &pid])).unwrap();
        let _ = holder.kill();
        let _ = holder.wait();
        sbx.configure_with(LinkSetup::Existing).expect("configure sandbox netns");
        guest
            .run(|| {
                run_cmd("ip", &["link", "set", "lo", "up"])?;
                run_cmd("ip", &["addr", "add", &format!("{GUEST_IP}/30"), "dev", "eth0"])?;
                run_cmd("ip", &["link", "set", "eth0", "up"])?;
                run_cmd("ip", &["route", "add", "default", "via", GATEWAY_IP])
            })
            .unwrap();

        let https: OwnedFd = sbx.bind(Transport::Tcp, "172.16.0.1:443".parse().unwrap()).unwrap();
        let explicit: OwnedFd = sbx.bind(Transport::Tcp, "172.16.0.1:3128".parse().unwrap()).unwrap();
        let https = TcpListener::from(https);
        let explicit = TcpListener::from(explicit);

        let acceptor = std::thread::spawn(move || {
            let (mut s, _) = https.accept().unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).unwrap();
            s.write_all(b"pong").unwrap();
            let (mut s2, _) = explicit.accept().unwrap();
            s2.write_all(b"ok").unwrap();
        });
        // From the guest: any IP on :443 is redirected to the gateway listener.
        guest
            .run(|| {
                let mut c = TcpStream::connect("93.184.216.34:443")?;
                c.write_all(b"ping")?;
                let mut b = [0u8; 4];
                c.read_exact(&mut b)?;
                assert_eq!(&b, b"pong");
                let mut c2 = TcpStream::connect("172.16.0.1:3128")?;
                let mut b2 = [0u8; 2];
                c2.read_exact(&mut b2)?;
                assert_eq!(&b2, b"ok");
                // Anything else is dropped (no route out, input policy drop).
                let r = TcpStream::connect_timeout(&"172.16.0.1:22".parse().unwrap(), std::time::Duration::from_millis(300));
                assert!(r.is_err(), "port 22 must not be reachable");
                Ok(())
            })
            .unwrap();
        acceptor.join().unwrap();
    }
}
