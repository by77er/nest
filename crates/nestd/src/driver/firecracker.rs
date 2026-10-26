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
    /// The jailer's `--parent-cgroup` (relative to the cgroup root): `<nestd's cgroup>/vms` when the
    /// unit delegates its cgroup (`cgroup.rs`), so the unit's stop kills every VMM. `None`: the
    /// jailer's default parent, outside the unit.
    pub parent_cgroup: Option<String>,
    /// The cgroup v2 mount: a jailed VMM's cgroup is removed there once it has exited.
    pub cgroup_root: PathBuf,
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
        Ok(Box::new(FirecrackerVm { cfg: self.cfg.clone(), parent_cgroup: self.parent_cgroup.clone(), cgroup_root: self.cgroup_root.clone(), spec, child: None, jail }))
    }
}

/// Jail layout for one VM: host paths, and the same files as Firecracker sees them inside the
/// chroot.
#[derive(Clone, Debug)]
pub struct Jail {
    pub cfg: JailerConfig,
    /// The jailer's `--id`: the sandbox id with `_` as `-` (the jailer takes alphanumerics and
    /// `-` only, at most 64), plus a suffix unique to this VM, so a retry or the next epoch never
    /// shares a jail with one that's still being torn down.
    pub id: String,
    /// `<chroot_base>/<firecracker binary name>/<sandbox>/root`
    pub root: PathBuf,
}

impl Jail {
    pub fn new(fc: &FirecrackerConfig, cfg: &JailerConfig, spec: &VmSpec) -> Jail {
        let exe = fc.firecracker_bin.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "firecracker".into());
        let id = format!("{}-{}", spec.sandbox.0.replace('_', "-"), crate::util::random_hex(4));
        Jail { cfg: cfg.clone(), root: cfg.chroot_base_dir.join(exe).join(&id).join("root"), id }
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
    parent_cgroup: Option<String>,
    cgroup_root: PathBuf,
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

/// The jailer command line (pure, unit-tested). `memory_mib` is the guest's declared size: the
/// jailer puts the VMM in its own cgroup v2 with `memory.max` at that plus the configured overhead.
/// With `parent_cgroup`, the VMM's cgroup goes under it (`--parent-cgroup`), inside nestd's unit.
pub fn jailer_args(fc: &FirecrackerConfig, jail: &Jail, netns: &Path, api_sock: &Path, memory_mib: u32, parent_cgroup: Option<&str>) -> Vec<String> {
    let cap_bytes = (u64::from(memory_mib) + u64::from(fc.vm_memory_overhead_mib)) * 1024 * 1024;
    let mut a: Vec<String> = vec![
        "--cgroup-version".into(),
        "2".into(),
        "--cgroup".into(),
        format!("memory.max={cap_bytes}"),
    ];
    if let Some(p) = parent_cgroup {
        a.extend(["--parent-cgroup".into(), p.to_string()]);
    }
    a.extend([
        "--id".into(),
        jail.id.clone(),
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
    ]);
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
                c.args(jailer_args(&self.cfg, jail, ns_path, &paths.api_sock, self.spec.resources.memory_mib, self.parent_cgroup.as_deref()));
                c
            }
            _ => {
                let mut c = std::process::Command::new(&self.cfg.firecracker_bin);
                c.arg("--api-sock").arg(&paths.api_sock);
                c
            }
        };
        cmd.stdin(std::process::Stdio::null());
        // Dies with nestd (the jailer drops its uid, which clears the death signal: a jailed VMM is
        // covered by its cgroup instead). Unjailed, it enters the netns itself; the jailer does that.
        let netns = if self.jail.is_none() { self.spec.netns.clone() } else { None };
        let child = super::supervise::spawn(cmd, netns)?;
        let pid = child.id();
        // Held first: on any error below, stop or drop reaps it.
        self.child = Some(child);
        super::supervise::write_pidfile(&self.spec.vm_dir, pid)?;
        // Wait for the API socket (the jailer first copies Firecracker into the chroot).
        for _ in 0..500 {
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
        if let Some(j) = &self.jail {
            // The VMM has exited: its (now empty) cgroup goes too, so they don't pile up.
            let cg = self.vmm_cgroup(j);
            match std::fs::remove_dir(&cg) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => tracing::warn!(cgroup = %cg.display(), error = %e, "removing a stopped VMM's cgroup"),
                _ => {}
            }
            j.remove()?;
        }
        Ok(())
    }
}

impl FirecrackerVm {
    /// The jailer's cgroup for this VMM: `<root>/<parent>/<jail id>`, the parent being the
    /// delegated one or the jailer's default (the exec file's name).
    fn vmm_cgroup(&self, j: &Jail) -> PathBuf {
        let parent = self.parent_cgroup.clone().unwrap_or_else(|| self.cfg.firecracker_bin.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "firecracker".into()));
        self.cgroup_root.join(parent).join(&j.id)
    }
}

/// Remove every jail under `chroot_base` (at nestd start, after its leftover VMMs were killed:
/// any jail left is from a crash or a reboot).
pub fn remove_stale_jails(fc: &FirecrackerConfig, jail: &JailerConfig) -> io::Result<usize> {
    let exe = fc.firecracker_bin.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "firecracker".into());
    let dir = jail.chroot_base_dir.join(exe);
    let mut n = 0;
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with("sbx-") {
            std::fs::remove_dir_all(e.path())?;
            n += 1;
        }
    }
    Ok(n)
}

impl Jail {
    /// Remove this VM's jail directory (its hard links to the kernel and disk, the sockets and the
    /// device nodes the jailer made) once Firecracker has exited. Only ever under the chroot base.
    fn remove(&self) -> io::Result<()> {
        let dir = self.root.parent().filter(|d| d.starts_with(&self.cfg.chroot_base_dir) && d.ends_with(&self.id));
        match dir {
            Some(d) => match std::fs::remove_dir_all(d) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
            None => Err(io::Error::other(format!("refusing to remove {}: not a jail directory", self.root.display()))),
        }
    }
}

impl Drop for FirecrackerVm {
    fn drop(&mut self) {
        if let Some(c) = &mut self.child {
            let _ = c.kill();
            let _ = c.wait();
            if let Some(j) = &self.jail {
                let _ = j.remove();
            }
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
        // Firecracker keeps the connection open after it answers, `Connection: close` or not: read
        // one response (headers, then `Content-Length` bytes), never to EOF.
        let (status, resp_body) = tokio::time::timeout(Duration::from_secs(30), read_response(&mut s))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, format!("firecracker {method} {path}: API timed out")))??;
        if !(200..300).contains(&status) {
            return Err(io::Error::other(format!("firecracker {method} {path}: {status} {resp_body}")));
        }
        Ok(resp_body)
    }
}

/// One HTTP/1.1 response: its status and body. The body is `Content-Length` bytes (none if absent).
async fn read_response(s: &mut UnixStream) -> io::Result<(u16, String)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "firecracker closed the API connection mid-response"));
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let status: u16 = head.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let len: usize = head
        .lines()
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse().ok()))
        .unwrap_or(0);
    while buf.len() < head_end + len {
        let n = s.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "firecracker closed the API connection mid-body"));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok((status, String::from_utf8_lossy(&buf[head_end..head_end + len]).into_owned()))
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
            vm_memory_overhead_mib: 128,
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

    /// A stopped jailed VMM's cgroup is removed (under the delegated parent here), and nothing else.
    #[tokio::test]
    async fn stop_removes_the_vmm_cgroup() {
        let dir = tempfile::tempdir().unwrap();
        let mut fc = cfg();
        fc.jailer_bin = Some("/usr/bin/jailer".into());
        fc.jailer = Some(JailerConfig { uid: 900, gid: 900, chroot_base_dir: dir.path().join("jail") });
        let root = dir.path().join("cgroup");
        let driver = FirecrackerDriver { cfg: fc, parent_cgroup: Some("system.slice/nestd.service/vms".into()), cgroup_root: root.clone() };
        let mut s = spec();
        s.vm_dir = dir.path().join("vm");
        let mut vm = driver.create(s).await.unwrap();
        let uds = vm.vsock_uds_path();
        let id = uds.parent().unwrap().parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        let vms = root.join("system.slice/nestd.service/vms");
        std::fs::create_dir_all(vms.join(&id)).unwrap();
        std::fs::create_dir_all(vms.join("sbx-other-1234")).unwrap();
        vm.stop().await.unwrap();
        assert!(!vms.join(&id).exists(), "the stopped VMM's cgroup is still there");
        assert!(vms.join("sbx-other-1234").exists());
    }

    /// Review #16: the jailer gets uid/gid/chroot, and Firecracker sees jail-relative paths while
    /// nestd uses the host paths under the jail root.
    #[tokio::test]
    async fn jailed_vm_uses_chroot_relative_paths() {
        let mut fc = cfg();
        fc.jailer_bin = Some("/usr/bin/jailer".into());
        fc.jailer = Some(JailerConfig { uid: 900, gid: 900, chroot_base_dir: "/srv/jailer".into() });
        let driver = FirecrackerDriver { cfg: fc.clone(), parent_cgroup: None, cgroup_root: "/sys/fs/cgroup".into() };
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec();
        s.vm_dir = dir.path().join("vm");
        let vm = driver.create(s.clone()).await.unwrap();
        // The jailer rejects `_` in ids (alphanumerics and `-` only): the jail is sbx-1-<suffix>,
        // unique per VM.
        let uds = vm.vsock_uds_path().display().to_string();
        assert!(uds.starts_with("/srv/jailer/firecracker/sbx-1-") && uds.ends_with("/root/vsock.sock"), "{uds}");
        let jail = Jail::new(&fc, fc.jailer.as_ref().unwrap(), &s);
        assert_ne!(jail.id, Jail::new(&fc, fc.jailer.as_ref().unwrap(), &s).id);
        assert!(jail.id.len() <= 64 && jail.id.chars().all(|c| c == '-' || c.is_ascii_alphanumeric()), "{}", jail.id);
        let args = jailer_args(&fc, &jail, Path::new("/run/netns/ns-sbx_1"), Path::new("/api.sock"), s.resources.memory_mib, None);
        let joined = args.join(" ");
        // The VMM's cgroup caps memory at the declared size plus the overhead: 2048 + 128 MiB here.
        assert!(joined.starts_with(&format!("--cgroup-version 2 --cgroup memory.max={} --id {} ", 2176u64 * 1024 * 1024, jail.id)), "{joined}");
        // Under a delegated nestd cgroup, the VMM's cgroup goes inside the unit (its stop kills it).
        let delegated = jailer_args(&fc, &jail, Path::new("/run/netns/ns-sbx_1"), Path::new("/api.sock"), s.resources.memory_mib, Some("system.slice/nestd.service/vms")).join(" ");
        assert!(delegated.starts_with(&format!("--cgroup-version 2 --cgroup memory.max={} --parent-cgroup system.slice/nestd.service/vms --id {} ", 2176u64 * 1024 * 1024, jail.id)), "{delegated}");
        assert!(joined.contains("--uid 900 --gid 900 --chroot-base-dir /srv/jailer --netns /run/netns/ns-sbx_1 -- --api-sock /api.sock"), "{joined}");
        let paths = FcPaths { api_sock: "/api.sock".into(), kernel: "/vmlinux".into(), disk: "/disk.img".into(), vsock: "/vsock.sock".into() };
        let reqs = boot_requests(&fc, &s, &paths);
        assert_eq!(reqs[1].2["kernel_image_path"], "/vmlinux");
        assert_eq!(reqs[2].2["path_on_host"], "/disk.img");
        // A jailer without uid/gid/chroot settings is a configuration error.
        fc.jailer = None;
        assert!(FirecrackerDriver { cfg: fc, parent_cgroup: None, cgroup_root: "/sys/fs/cgroup".into() }.create(s).await.is_err());
    }

    /// Stopping a jailed VM removes its jail directory, and only that.
    #[test]
    fn jail_removal_stays_inside_the_chroot_base() {
        let base = tempfile::tempdir().unwrap();
        let mut fc = cfg();
        let jc = JailerConfig { uid: 0, gid: 0, chroot_base_dir: base.path().into() };
        fc.jailer = Some(jc.clone());
        let jail = Jail::new(&fc, &jc, &spec());
        std::fs::create_dir_all(jail.root.join("dev")).unwrap();
        std::fs::write(jail.root.join("disk.img"), b"x").unwrap();
        let sibling = base.path().join("firecracker").join("sbx-2-abcd");
        std::fs::create_dir_all(&sibling).unwrap();
        jail.remove().unwrap();
        assert!(!jail.root.parent().unwrap().exists());
        assert!(sibling.exists());
        jail.remove().unwrap(); // idempotent
        let id = jail.id.clone();
        let outside = Jail { root: format!("/tmp/elsewhere/{id}/root").into(), ..jail };
        assert!(outside.remove().is_err());
        // At start, nestd clears what a crash left (only jails, nothing else in the base).
        std::fs::write(base.path().join("firecracker").join("keep.txt"), b"").unwrap();
        assert_eq!(remove_stale_jails(&fc, &jc).unwrap(), 1);
        assert!(!sibling.exists());
        assert!(base.path().join("firecracker").join("keep.txt").exists());
    }

    #[tokio::test]
    async fn api_client_speaks_http_over_uds() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("fc.sock");
        let l = UnixListener::bind(&sock).unwrap();
        // Like Firecracker, the server answers and keeps the connection open (it closes only when
        // the test ends): a client that reads to EOF hangs here.
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let mut reqs = vec![];
            let replies: [&[u8]; 3] = [
                b"HTTP/1.1 204 No Content\r\n\r\n",
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\ncontent-length: 14\r\n\r\n{\"state\":\"Ok\"}",
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 22\r\n\r\n{\"fault_message\":\"no\"}",
            ];
            let mut held = vec![];
            for reply in replies {
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = s.read(&mut buf).await.unwrap();
                reqs.push(String::from_utf8_lossy(&buf[..n]).to_string());
                s.write_all(reply).await.unwrap();
                held.push(s);
            }
            let _ = done_rx.await;
            reqs
        });
        let c = ApiClient { sock };
        let t = Duration::from_secs(5);
        tokio::time::timeout(t, c.call("PATCH", "/vm", Some(&json!({"state": "Paused"})))).await.unwrap().unwrap();
        assert_eq!(tokio::time::timeout(t, c.call("GET", "/vm", None)).await.unwrap().unwrap(), "{\"state\":\"Ok\"}");
        let err = tokio::time::timeout(t, c.call("PUT", "/actions", None)).await.unwrap().unwrap_err();
        assert!(err.to_string().contains("400 {\"fault_message\":\"no\"}"), "{err}");
        done_tx.send(()).unwrap();
        let reqs = server.await.unwrap();
        assert!(reqs[0].starts_with("PATCH /vm HTTP/1.1\r\n"));
        assert!(reqs[0].ends_with("{\"state\":\"Paused\"}"));
    }
}
