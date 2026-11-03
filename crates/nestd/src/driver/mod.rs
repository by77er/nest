//! VM drivers (`docs/sandbox/drivers/`).
//!
//! A [`Driver`] creates [`Vm`]s. Every VM exposes a hybrid-vsock unix socket (real Firecracker or
//! the emulator), so nestd's guest control and the runner's hands RPC are driver-agnostic.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use nest_protocol::model::{Epoch, Resources, SandboxId};

use crate::net::Netns;

pub mod access;
pub mod firecracker;
pub mod process;
pub mod supervise;

#[derive(Clone)]
pub struct VmSpec {
    pub sandbox: SandboxId,
    pub epoch: Epoch,
    pub image: String,
    pub resources: Resources,
    /// Per-VM runtime directory (sockets, snapshots).
    pub vm_dir: PathBuf,
    /// Writable disk image for this sandbox (already materialized: fresh sparse file, or
    /// restored from a generation).
    pub disk_path: PathBuf,
    /// The sandbox netns, if networking is enabled. The VM's tap device lives there.
    pub netns: Option<Arc<Netns>>,
}

#[async_trait]
pub trait Driver: Send + Sync {
    /// Whether [`Vm::snapshot_memory`] produces a restorable memory snapshot.
    fn supports_memory_snapshots(&self) -> bool {
        false
    }
    /// Whether a paused or stopped VM writes nothing more to its disk file: every write it began
    /// has landed, and none starts until it resumes. A commit trusts its unchanged-disk check
    /// (`nestd_core::checkpoint`) only then.
    fn pause_quiesces_disk(&self) -> bool {
        false
    }
    async fn create(&self, spec: VmSpec) -> io::Result<Box<dyn Vm>>;
}

/// A brain host's driver: it runs no sandboxes, so every create is refused (nestd refuses sandbox
/// commands there before reaching it; this is the backstop).
pub struct NoDriver;

#[async_trait]
impl Driver for NoDriver {
    async fn create(&self, _spec: VmSpec) -> io::Result<Box<dyn Vm>> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "a brain host runs no sandboxes"))
    }
}

/// A lock-free handle that freezes a VM's vCPUs. Fencing uses it so a sandbox is paused at once,
/// even while a long command holds the sandbox's own lock.
#[async_trait]
pub trait Pauser: Send + Sync {
    async fn pause(&self) -> io::Result<()>;
}

#[async_trait]
pub trait Vm: Send + Sync {
    /// Lock-free pause handle (available once started).
    fn pauser(&self) -> Option<Arc<dyn Pauser>> {
        None
    }
    /// Host-side hybrid-vsock unix socket (`CONNECT <port>` handshake).
    fn vsock_uds_path(&self) -> PathBuf;
    /// Boot the VM (cold boot from `disk_path`).
    async fn start(&mut self) -> io::Result<()>;
    /// Freeze vCPUs; memory and processes are kept.
    async fn pause(&mut self) -> io::Result<()>;
    async fn resume(&mut self) -> io::Result<()>;
    /// Full memory snapshot of a paused VM into `dir`. Returns the memory file, if supported.
    async fn snapshot_memory(&mut self, _dir: &std::path::Path) -> io::Result<Option<PathBuf>> {
        Ok(None)
    }
    /// Stop and release the VM (idempotent).
    async fn stop(&mut self) -> io::Result<()>;
}
