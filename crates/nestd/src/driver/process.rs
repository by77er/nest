//! `process` driver: runs the guest agent as a host child process (local development and tests,
//! no KVM). vsock is emulated: the guest listens on `<vm_dir>/guest/<port>.sock`
//! (`--listen unix:<dir>`) and [`crate::vsock::Emulator`] serves `<vm_dir>/vsock.sock`.
//!
//! The child starts inside the sandbox netns (when networking is enabled), so its egress hits the
//! same nft rules and proxy listeners a VM would, and dies with nestd (`supervise.rs`).
//! Pause/resume are SIGSTOP/SIGCONT.
//!
//! With `mount_disk` (root only), the disk image is formatted ext4 on first use and the guest
//! runs in a private mount namespace with it loop-mounted at `/workspace`, so what an agent writes
//! there is in the image that commits upload and restores bring back, as with a VM's disk.

use std::io;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

use super::{Driver, Pauser, Vm, VmSpec};
use crate::vsock::Emulator;

pub struct ProcessDriver {
    /// Guest agent command; `--listen unix:<dir>` is appended.
    pub guest_command: Vec<String>,
    /// Loop-mount the disk image at `/workspace` in the guest's own mount namespace.
    pub mount_disk: bool,
    /// The gateway's group (`sockets.gateway_gid`): each VM's vsock socket is given to it
    /// (`access.rs`). `None`: the socket keeps nestd's umask mode.
    pub gateway_gid: Option<u32>,
    /// nestd's `run_dir`: each VM's directory under it is made search-only (`0711`) whatever the
    /// umask, so the gateway's user can reach the vsock socket inside.
    pub run_dir: PathBuf,
}

/// Where the image is mounted inside the guest's mount namespace.
pub const WORKSPACE: &str = "/workspace";

/// Whether `path` holds an ext2/3/4 filesystem (superblock magic `0xEF53` at byte 1080).
fn has_ext4(path: &Path) -> io::Result<bool> {
    let f = std::fs::File::open(path)?;
    let mut magic = [0u8; 2];
    match f.read_exact_at(&mut magic, 1080) {
        Ok(()) => Ok(magic == [0x53, 0xEF]),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(e),
    }
}

/// Format a fresh (all-holes) image; a restored one already has its filesystem.
fn ensure_ext4(path: &Path) -> io::Result<()> {
    if has_ext4(path)? {
        return Ok(());
    }
    let out = std::process::Command::new("mkfs.ext4")
        .args(["-F", "-q", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard"])
        .arg(path)
        .output()?;
    if !out.status.success() {
        return Err(io::Error::other(format!("mkfs.ext4: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

#[async_trait]
impl Driver for ProcessDriver {
    async fn create(&self, spec: VmSpec) -> io::Result<Box<dyn Vm>> {
        if self.guest_command.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "process driver: empty guest_command"));
        }
        super::access::create_searchable(&self.run_dir, &spec.vm_dir)?;
        Ok(Box::new(ProcessVm { cmd: self.guest_command.clone(), mount_disk: self.mount_disk, gateway_gid: self.gateway_gid, spec, child: None, emulator: None }))
    }
}

pub struct ProcessVm {
    cmd: Vec<String>,
    mount_disk: bool,
    gateway_gid: Option<u32>,
    spec: VmSpec,
    child: Option<std::process::Child>,
    emulator: Option<Emulator>,
}

impl ProcessVm {
    fn guest_dir(&self) -> PathBuf {
        self.spec.vm_dir.join("guest")
    }
    fn signal(&self, sig: Signal) -> io::Result<()> {
        if let Some(c) = &self.child {
            kill(Pid::from_raw(c.id() as i32), sig).map_err(io::Error::from)?;
        }
        Ok(())
    }
}

struct PidPauser(i32);

#[async_trait]
impl Pauser for PidPauser {
    async fn pause(&self) -> io::Result<()> {
        kill(Pid::from_raw(self.0), Signal::SIGSTOP).map_err(io::Error::from)
    }
}

#[async_trait]
impl Vm for ProcessVm {
    fn pauser(&self) -> Option<Arc<dyn Pauser>> {
        self.child.as_ref().map(|c| Arc::new(PidPauser(c.id() as i32)) as Arc<dyn Pauser>)
    }
    fn vsock_uds_path(&self) -> PathBuf {
        self.spec.vm_dir.join("vsock.sock")
    }
    async fn start(&mut self) -> io::Result<()> {
        let guest_dir = self.guest_dir();
        std::fs::create_dir_all(&guest_dir)?;
        self.emulator = Some(Emulator::start(&self.vsock_uds_path(), &guest_dir)?);
        if let Some(gid) = self.gateway_gid {
            super::access::grant_socket(&self.vsock_uds_path(), nix::unistd::geteuid().as_raw(), gid)?;
        }
        let mut cmd = if self.mount_disk {
            let disk = self.spec.disk_path.clone();
            tokio::task::spawn_blocking(move || ensure_ext4(&disk)).await.map_err(io::Error::other)??;
            std::fs::create_dir_all(WORKSPACE)?;
            // unshare execs in place and sh execs the guest, so the child's pid is the guest's
            // (pause and stop signal it directly). The mount dies with the namespace.
            let mut c = std::process::Command::new("unshare");
            c.args(["--mount", "--propagation", "private", "--", "/bin/sh", "-c", r#"mount -o loop "$1" "$2" && shift 2 && exec "$@""#, "nest-mount"])
                .arg(&self.spec.disk_path)
                .arg(WORKSPACE)
                .args(&self.cmd);
            c
        } else {
            let mut c = std::process::Command::new(&self.cmd[0]);
            c.args(&self.cmd[1..]);
            c
        };
        cmd.arg("--listen")
            .arg(format!("unix:{}", guest_dir.display()))
            .env("NEST_DISK_IMAGE", &self.spec.disk_path)
            .stdin(std::process::Stdio::null());
        // Dies with nestd, and starts inside the sandbox netns (`supervise.rs`).
        let child = super::supervise::spawn(cmd, self.spec.netns.clone())?;
        let pid = child.id();
        // Held first: on any error below, stop or drop reaps it.
        self.child = Some(child);
        super::supervise::write_pidfile(&self.spec.vm_dir, pid)?;
        Ok(())
    }
    async fn pause(&mut self) -> io::Result<()> {
        self.signal(Signal::SIGSTOP)
    }
    async fn resume(&mut self) -> io::Result<()> {
        self.signal(Signal::SIGCONT)
    }
    async fn stop(&mut self) -> io::Result<()> {
        if let Some(mut c) = self.child.take() {
            let _ = kill(Pid::from_raw(c.id() as i32), Signal::SIGCONT);
            let _ = c.kill();
            let _ = tokio::task::spawn_blocking(move || c.wait()).await;
        }
        self.emulator = None;
        Ok(())
    }
}

impl Drop for ProcessVm {
    fn drop(&mut self) {
        if let Some(c) = &mut self.child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With a gateway group, the vsock socket a started VM exposes is `0660` in that group, so the
    /// gateway (another user) can dial it. Without the grant it has nestd's umask mode (`0755`
    /// under systemd), which no other user can connect to. The directories down to it are
    /// search-only whatever nestd's umask (here left `0700`, as under umask 077).
    #[tokio::test]
    async fn the_vsock_socket_is_given_to_the_gateway_group() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let gid = nix::unistd::getegid().as_raw();
        let dir = tempfile::tempdir().unwrap();
        let vm_dir = dir.path().join("vm/sbx_gw/1");
        std::fs::create_dir_all(&vm_dir).unwrap();
        let chain = [dir.path().join("vm"), dir.path().join("vm/sbx_gw"), vm_dir.clone()];
        for d in &chain {
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let driver = ProcessDriver { guest_command: vec!["/bin/sh".into(), "-c".into(), "exec sleep 30".into()], mount_disk: false, gateway_gid: Some(gid), run_dir: dir.path().into() };
        let spec = VmSpec {
            sandbox: nest_protocol::model::SandboxId("sbx_gw".into()),
            epoch: nest_protocol::model::Epoch(1),
            image: "test".into(),
            resources: nest_protocol::model::Resources { vcpus: 1, memory_mib: 128, disk_gib: 1 },
            vm_dir,
            disk_path: dir.path().join("disk.img"),
            netns: None,
        };
        let mut vm = driver.create(spec).await.unwrap();
        vm.start().await.unwrap();
        let meta = std::fs::metadata(vm.vsock_uds_path()).unwrap();
        vm.stop().await.unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o660);
        assert_eq!(meta.gid(), gid);
        for d in &chain {
            assert_eq!(std::fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o711, "{}", d.display());
        }
    }

    /// A fresh image is formatted once; a formatted (e.g. restored) one is left alone.
    #[test]
    fn formats_a_fresh_image_once() {
        if std::process::Command::new("mkfs.ext4").arg("-V").output().is_err() {
            eprintln!("skipping: no mkfs.ext4");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("disk.img");
        crate::storage::create_sparse(&img, 256 << 20).unwrap();
        assert!(!has_ext4(&img).unwrap());
        ensure_ext4(&img).unwrap();
        assert!(has_ext4(&img).unwrap());
        let before = std::fs::read(&img).unwrap();
        ensure_ext4(&img).unwrap();
        assert_eq!(before, std::fs::read(&img).unwrap(), "an existing filesystem is never reformatted");
    }

    /// What the guest writes under /workspace and syncs is in the image file itself (what a commit
    /// chunks), read from outside the guest's mount namespace while it still runs.
    #[tokio::test]
    async fn guest_writes_land_in_the_disk_image() {
        let probe = std::process::Command::new("unshare").args(["--mount", "true"]).status();
        if !nix::unistd::geteuid().is_root() || !probe.is_ok_and(|s| s.success()) || std::process::Command::new("debugfs").arg("-V").output().is_err() {
            eprintln!("skipping: needs root, mount namespaces and debugfs");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("disk.img");
        crate::storage::create_sparse(&img, 256 << 20).unwrap();
        let driver = ProcessDriver {
            guest_command: vec!["/bin/sh".into(), "-c".into(), "echo state-that-moves > /workspace/marker && sync && exec sleep 30".into()],
            mount_disk: true,
            gateway_gid: None,
            run_dir: dir.path().into(),
        };
        let spec = VmSpec {
            sandbox: nest_protocol::model::SandboxId("sbx_mounttest".into()),
            epoch: nest_protocol::model::Epoch(1),
            image: "test".into(),
            resources: nest_protocol::model::Resources { vcpus: 1, memory_mib: 128, disk_gib: 1 },
            vm_dir: dir.path().join("vm"),
            disk_path: img.clone(),
            netns: None,
        };
        let mut vm = driver.create(spec).await.unwrap();
        vm.start().await.unwrap();
        let mut found = String::new();
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let out = std::process::Command::new("debugfs").args(["-R", "cat /marker"]).arg(&img).output().unwrap();
            found = String::from_utf8_lossy(&out.stdout).to_string();
            if found.contains("state-that-moves") {
                break;
            }
        }
        vm.stop().await.unwrap();
        assert!(found.contains("state-that-moves"), "image holds: {found:?}");
        assert!(!std::path::Path::new("/workspace/marker").exists(), "the mount is private to the guest");
    }
}
