//! `process` driver: runs the guest agent as a host child process (local development and tests,
//! no KVM). vsock is emulated: the guest listens on `<vm_dir>/guest/<port>.sock`
//! (`--listen unix:<dir>`) and [`crate::vsock::Emulator`] serves `<vm_dir>/vsock.sock`.
//!
//! The child starts inside the sandbox netns (when networking is enabled), so its egress hits the
//! same nft rules and proxy listeners a VM would. Pause/resume are SIGSTOP/SIGCONT.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

use super::{Driver, Pauser, Vm, VmSpec};
use crate::vsock::Emulator;

pub struct ProcessDriver {
    /// Guest agent command; `--listen unix:<dir>` is appended.
    pub guest_command: Vec<String>,
}

#[async_trait]
impl Driver for ProcessDriver {
    fn name(&self) -> &'static str {
        "process"
    }
    async fn create(&self, spec: VmSpec) -> io::Result<Box<dyn Vm>> {
        if self.guest_command.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "process driver: empty guest_command"));
        }
        std::fs::create_dir_all(&spec.vm_dir)?;
        Ok(Box::new(ProcessVm { cmd: self.guest_command.clone(), spec, child: None, emulator: None }))
    }
}

pub struct ProcessVm {
    cmd: Vec<String>,
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
    fn disk_path(&self) -> PathBuf {
        self.spec.disk_path.clone()
    }
    async fn start(&mut self) -> io::Result<()> {
        let guest_dir = self.guest_dir();
        std::fs::create_dir_all(&guest_dir)?;
        self.emulator = Some(Emulator::start(&self.vsock_uds_path(), &guest_dir)?);
        let mut cmd = std::process::Command::new(&self.cmd[0]);
        cmd.args(&self.cmd[1..])
            .arg("--listen")
            .arg(format!("unix:{}", guest_dir.display()))
            .env("NEST_DISK_IMAGE", &self.spec.disk_path)
            .stdin(std::process::Stdio::null());
        let child = match &self.spec.netns {
            Some(ns) => {
                let ns: Arc<_> = ns.clone();
                ns.run(move || cmd.spawn())?
            }
            None => cmd.spawn()?,
        };
        self.child = Some(child);
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
