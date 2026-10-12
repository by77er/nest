//! Firecracker driver (`docs/sandbox/drivers/firecracker/`).
//!
//! Boots a microVM through Firecracker's HTTP API over its unix socket: 2 MiB hugetlbfs memory,
//! the sandbox disk as the root drive, `tap0` from the sandbox netns, and hybrid vsock (guest CID
//! 3). The process is started inside the sandbox netns:
//! - **jailed (production):** `jailer --id <sandbox> --uid --gid --chroot-base-dir --netns
//!   <persisted path>`; the kernel and disk are hard-linked into the jail root
//!   (`<chroot_base>/firecracker/<sandbox>/root`), and every path Firecracker sees (API socket,
//!   kernel, disk, vsock socket) is relative to that root;
//! - **unjailed (development only):** Firecracker runs directly with nestd's privileges from a
//!   thread that entered the netns. A VMM escape then gets root on the host; nestd logs a warning.
//!
//! Not integration-tested here (no `/dev/kvm` access); the API requests are unit-tested against a
//! fake API server.
//!
//! TODO: memory-snapshot restore needs the UFFD handler (hugetlbfs snapshots can only be loaded
//! with the `Uffd` backend); until then restores are cold boots from the disk generation.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nest_protocol::guest::GUEST_CID;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use super::{Driver, Pauser, Vm, VmSpec};
use crate::config::{FirecrackerConfig, JailerConfig};
use crate::net::TAP_NAME;

pub struct FirecrackerDriver {
    pub cfg: FirecrackerConfig,
}

#[async_trait]
impl Driver for FirecrackerDriver {
    fn name(&self) -> &'static str {
        "firecracker"
    }
    fn supports_memory_snapshots(&self) -> bool {
        true
    }
    async fn create(&self, spec: VmSpec) -> io::Result<Box<dyn Vm>> {
        std::fs::create_dir_all(&spec.vm_dir)?;
        let jail = match (&self.cfg.jailer_bin, &self.cfg.jailer) {
            (Some(_), Some(j)) => Some(Jail::new(&self.cfg, j, &spec)),
            (Some(_), None) => return Err(io::Error::new(io::ErrorKind::InvalidInput, "jailer_bin is set but `jailer` (uid/gid/chroot) is not")),
            (None, _) => {
                tracing::warn!(sandbox = %spec.sandbox, "starting Firecracker WITHOUT the jailer (development only: a VMM escape gets nestd's privileges)");
                None
            }
        };
        Ok(Box::new(FirecrackerVm { cfg: self.cfg.clone(), spec, child: None, jail }))
    }
}

/// Jail layout for one VM: host paths, and the same files as Firecracker sees them inside the
/// chroot.
#[derive(Clone, Debug)]
pub struct Jail {
    pub cfg: JailerConfig,
    /// `<chroot_base>/<firecracker binary name>/<sandbox>/root`
    pub root: PathBuf,
}

impl Jail {
    pub fn new(fc: &FirecrackerConfig, cfg: &JailerConfig, spec: &VmSpec) -> Jail {
        let exe = fc.firecracker_bin.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "firecracker".into());
        Jail { cfg: cfg.clone(), root: cfg.chroot_base_dir.join(exe).join(&spec.sandbox.0).join("root") }
    }

    /// Hard-link the kernel and disk into the jail root, owned by the jail uid/gid.
    fn populate(&self, fc: &FirecrackerConfig, spec: &VmSpec) -> io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        for (src, name) in [(&fc.kernel_image, "vmlinux"), (&spec.disk_path, "disk.img")] {
            let dst = self.root.join(name);
            let _ = std::fs::remove_file(&dst);
            std::fs::hard_link(src, &dst).map_err(|e| io::Error::new(e.kind(), format!("hard-link {} into the jail (same filesystem required): {e}", src.display())))?;
        }
        let (uid, gid) = (nix::unistd::Uid::from_raw(self.cfg.uid), nix::unistd::Gid::from_raw(self.cfg.gid));
        nix::unistd::chown(&self.root.join("disk.img"), Some(uid), Some(gid)).map_err(io::Error::from)?;
        Ok(())
    }
}

/// Paths as Firecracker sees them (jail-relative when jailed).
#[derive(Clone, Debug)]
pub struct FcPaths {
    pub api_sock: PathBuf,
    pub kernel: PathBuf,
    pub disk: PathBuf,
    pub vsock: PathBuf,
}

pub struct FirecrackerVm {
    cfg: FirecrackerConfig,
    spec: VmSpec,
    child: Option<std::process::Child>,
    jail: Option<Jail>,
}

impl FirecrackerVm {
    /// Paths inside Firecracker's view of the filesystem.
    fn fc_paths(&self) -> FcPaths {
        match &self.jail {
            Some(_) => FcPaths { api_sock: "/api.sock".into(), kernel: "/vmlinux".into(), disk: "/disk.img".into(), vsock: "/vsock.sock".into() },
            None => FcPaths {
                api_sock: self.spec.vm_dir.join("fc.sock"),
                kernel: self.cfg.kernel_image.clone(),
                disk: self.spec.disk_path.clone(),
                vsock: self.spec.vm_dir.join("vsock.sock"),
            },
        }
    }

    /// Host-side path of a Firecracker-visible path.
    fn host_path(&self, p: &Path) -> PathBuf {
        match &self.jail {
            Some(j) => j.root.join(p.strip_prefix("/").unwrap_or(p)),
            None => p.to_path_buf(),
        }
    }

    fn api_sock(&self) -> PathBuf {
        self.host_path(&self.fc_paths().api_sock)
    }

    fn api(&self) -> ApiClient {
        ApiClient { sock: self.api_sock() }
    }
}

/// The jailer command line (pure, unit-tested).
pub fn jailer_args(fc: &FirecrackerConfig, jail: &Jail, sandbox: &str, netns: &Path, api_sock: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "--id".into(),
        sandbox.into(),
        "--exec-file".into(),
        fc.firecracker_bin.display().to_string(),
        "--uid".into(),
        jail.cfg.uid.to_string(),
        "--gid".into(),
        jail.cfg.gid.to_string(),
        "--chroot-base-dir".into(),
        jail.cfg.chroot_base_dir.display().to_string(),
        "--netns".into(),
        netns.display().to_string(),
    ];
    a.extend(["--".into(), "--api-sock".into(), api_sock.display().to_string()]);
    a
}

struct ApiPauser(PathBuf);

#[async_trait]
impl Pauser for ApiPauser {
    async fn pause(&self) -> io::Result<()> {
        ApiClient { sock: self.0.clone() }.call("PATCH", "/vm", Some(&json!({ "state": "Paused" }))).await.map(|_| ())
    }
}

/// The boot-time API calls, in order (pure, unit-tested). Paths are as Firecracker sees them.
pub fn boot_requests(cfg: &FirecrackerConfig, spec: &VmSpec, paths: &FcPaths) -> Vec<(&'static str, String, Value)> {
    let mut machine = json!({
        "vcpu_count": spec.resources.vcpus,
        "mem_size_mib": spec.resources.memory_mib,
        "smt": false,
    });
    if cfg.huge_pages {
        machine["huge_pages"] = json!("2M");
    }
    vec![
        ("PUT", "/machine-config".into(), machine),
        ("PUT", "/boot-source".into(), json!({ "kernel_image_path": paths.kernel, "boot_args": cfg.boot_args })),
        (
            "PUT",
            "/drives/rootfs".into(),
            json!({ "drive_id": "rootfs", "path_on_host": paths.disk, "is_root_device": true, "is_read_only": false }),
        ),
        (
            "PUT",
            "/network-interfaces/eth0".into(),
            json!({ "iface_id": "eth0", "host_dev_name": TAP_NAME, "guest_mac": "06:00:AC:10:00:02" }),
        ),
        ("PUT", "/vsock".into(), json!({ "guest_cid": GUEST_CID, "uds_path": paths.vsock })),
        ("PUT", "/actions".into(), json!({ "action_type": "InstanceStart" })),
    ]
}

#[async_trait]
impl Vm for FirecrackerVm {
    fn pauser(&self) -> Option<Arc<dyn Pauser>> {
        Some(Arc::new(ApiPauser(self.api_sock())))
    }
    fn vsock_uds_path(&self) -> PathBuf {
        self.host_path(&self.fc_paths().vsock)
    }
    fn disk_path(&self) -> PathBuf {
        self.spec.disk_path.clone()
    }
    async fn start(&mut self) -> io::Result<()> {
        let paths = self.fc_paths();
        let _ = std::fs::remove_file(self.api_sock());
        let _ = std::fs::remove_file(self.vsock_uds_path());
        let mut cmd = match (&self.cfg.jailer_bin, &self.jail) {
            (Some(jailer), Some(jail)) => {
                let ns_path = self
                    .spec
                    .netns
                    .as_ref()
                    .and_then(|n| n.path())
                    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the jailer needs a persisted netns (network.persist_dir)"))?;
                jail.populate(&self.cfg, &self.spec)?;
                let mut c = std::process::Command::new(jailer);
                c.args(jailer_args(&self.cfg, jail, &self.spec.sandbox.0, ns_path, &paths.api_sock));
                c
            }
            _ => {
                let mut c = std::process::Command::new(&self.cfg.firecracker_bin);
                c.arg("--api-sock").arg(&paths.api_sock);
                c
            }
        };
        cmd.stdin(std::process::Stdio::null());
        let child = match (&self.jail, &self.spec.netns) {
            (None, Some(ns)) => {
                let ns: Arc<_> = ns.clone();
                ns.run(move || cmd.spawn())?
            }
            _ => cmd.spawn()?,
        };
        self.child = Some(child);
        // Wait for the API socket.
        for _ in 0..100 {
            if self.api_sock().exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let api = self.api();
        for (method, path, body) in boot_requests(&self.cfg, &self.spec, &paths) {
            api.call(method, &path, Some(&body)).await?;
        }
        Ok(())
    }
    async fn pause(&mut self) -> io::Result<()> {
        self.api().call("PATCH", "/vm", Some(&json!({ "state": "Paused" }))).await.map(|_| ())
    }
    async fn resume(&mut self) -> io::Result<()> {
        self.api().call("PATCH", "/vm", Some(&json!({ "state": "Resumed" }))).await.map(|_| ())
    }
    async fn snapshot_memory(&mut self, dir: &Path) -> io::Result<Option<PathBuf>> {
        std::fs::create_dir_all(dir)?;
        let mem = dir.join("mem");
        let body = json!({ "snapshot_type": "Full", "snapshot_path": dir.join("vmstate"), "mem_file_path": mem });
        self.api().call("PUT", "/snapshot/create", Some(&body)).await?;
        Ok(Some(mem))
    }
    async fn stop(&mut self) -> io::Result<()> {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = tokio::task::spawn_blocking(move || c.wait()).await;
        }
        Ok(())
    }
}

impl Drop for FirecrackerVm {
    fn drop(&mut self) {
        if let Some(c) = &mut self.child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Minimal HTTP/1.1 client for Firecracker's API socket (one request per connection).
pub struct ApiClient {
    pub sock: PathBuf,
}

impl ApiClient {
    pub async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> io::Result<String> {
        let mut s = UnixStream::connect(&self.sock).await?;
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let req = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await?;
        let mut resp = Vec::new();
        tokio::time::timeout(Duration::from_secs(30), s.read_to_end(&mut resp))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "firecracker API timed out"))??;
        let text = String::from_utf8_lossy(&resp).into_owned();
        let status: u16 = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let resp_body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(io::Error::other(format!("firecracker {method} {path}: {status} {resp_body}")));
        }
        Ok(resp_body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::{Epoch, Resources, SandboxId};
    use tokio::net::UnixListener;

    fn cfg() -> FirecrackerConfig {
        FirecrackerConfig {
            firecracker_bin: "/usr/bin/firecracker".into(),
            jailer_bin: None,
            jailer: None,
            kernel_image: "/var/lib/nest/vmlinux".into(),
            boot_args: "console=ttyS0".into(),
            images_dir: "/var/lib/nest/images".into(),
            huge_pages: true,
        }
    }

    fn spec() -> VmSpec {
        VmSpec {
            sandbox: SandboxId("sbx_1".into()),
            epoch: Epoch(1),
            image: "base".into(),
            resources: Resources { vcpus: 2, memory_mib: 2048, disk_gib: 8 },
            vm_dir: "/run/nest/vm/sbx_1".into(),
            disk_path: "/var/lib/nest/sandboxes/sbx_1/disk.img".into(),
            netns: None,
        }
    }

    #[test]
    fn boot_requests_configure_hugepages_tap_and_vsock() {
        let paths = FcPaths {
            api_sock: "/run/nest/vm/sbx_1/fc.sock".into(),
            kernel: "/var/lib/nest/vmlinux".into(),
            disk: "/var/lib/nest/sandboxes/sbx_1/disk.img".into(),
            vsock: "/run/nest/vm/sbx_1/vsock.sock".into(),
        };
        let reqs = boot_requests(&cfg(), &spec(), &paths);
        assert_eq!(reqs[0].2["huge_pages"], "2M");
        assert_eq!(reqs[0].2["mem_size_mib"], 2048);
        assert_eq!(reqs[3].2["host_dev_name"], "tap0");
        assert_eq!(reqs[4].2["guest_cid"], 3);
        assert_eq!(reqs.last().unwrap().2["action_type"], "InstanceStart");
    }

    /// Review #16: the jailer gets uid/gid/chroot, and Firecracker sees jail-relative paths while
    /// nestd uses the host paths under the jail root.
    #[tokio::test]
    async fn jailed_vm_uses_chroot_relative_paths() {
        let mut fc = cfg();
        fc.jailer_bin = Some("/usr/bin/jailer".into());
        fc.jailer = Some(JailerConfig { uid: 900, gid: 900, chroot_base_dir: "/srv/jailer".into() });
        let driver = FirecrackerDriver { cfg: fc.clone() };
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec();
        s.vm_dir = dir.path().join("vm");
        let vm = driver.create(s.clone()).await.unwrap();
        assert_eq!(vm.vsock_uds_path(), PathBuf::from("/srv/jailer/firecracker/sbx_1/root/vsock.sock"));
        let jail = Jail::new(&fc, fc.jailer.as_ref().unwrap(), &s);
        let args = jailer_args(&fc, &jail, "sbx_1", Path::new("/run/netns/ns-sbx_1"), Path::new("/api.sock"));
        let joined = args.join(" ");
        assert!(joined.contains("--uid 900 --gid 900 --chroot-base-dir /srv/jailer --netns /run/netns/ns-sbx_1 -- --api-sock /api.sock"), "{joined}");
        let paths = FcPaths { api_sock: "/api.sock".into(), kernel: "/vmlinux".into(), disk: "/disk.img".into(), vsock: "/vsock.sock".into() };
        let reqs = boot_requests(&fc, &s, &paths);
        assert_eq!(reqs[1].2["kernel_image_path"], "/vmlinux");
        assert_eq!(reqs[2].2["path_on_host"], "/disk.img");
        // A jailer without uid/gid/chroot settings is a configuration error.
        fc.jailer = None;
        assert!(FirecrackerDriver { cfg: fc }.create(s).await.is_err());
    }

    #[tokio::test]
    async fn api_client_speaks_http_over_uds() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("fc.sock");
        let l = UnixListener::bind(&sock).unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n").await.unwrap();
            req
        });
        let c = ApiClient { sock };
        c.call("PATCH", "/vm", Some(&json!({"state": "Paused"}))).await.unwrap();
        let req = server.await.unwrap();
        assert!(req.starts_with("PATCH /vm HTTP/1.1\r\n"));
        assert!(req.ends_with("{\"state\":\"Paused\"}"));
    }
}
