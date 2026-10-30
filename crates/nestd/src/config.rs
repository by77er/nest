//! nestd configuration (JSON file, `--config`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use nest_protocol::host::paths;
use nest_protocol::model::{HostId, HostRole};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    /// What this host is for, set at bootstrap (the launch template's user data writes it):
    /// `sandbox` runs sandboxes and everything beside them; `brain` runs nestd's supervisor duties
    /// only (enrollment, the fleet channel and lease, command delivery to the runner, self-fencing).
    /// See [`Config::validate`] for what each kind may configure.
    pub role: HostRole,
    /// e.g. `aws-us-east-1`; selects the object store and placement.
    pub cell: String,
    /// Base URL of the control-plane Worker, e.g. `https://nest.example.com`.
    #[serde(default)]
    pub control_url: String,
    pub enrollment: EnrollmentConfig,
    #[serde(default = "default_run_dir")]
    pub run_dir: PathBuf,
    #[serde(default = "default_state_dir")]
    pub state_dir: PathBuf,
    /// How sandboxes run: required on a sandbox host, refused on a brain host.
    #[serde(default)]
    pub driver: Option<DriverConfig>,
    #[serde(default)]
    pub network: NetworkConfig,
    /// Event batch flush interval (spec: 1–2 s).
    #[serde(default = "default_flush_ms")]
    pub flush_interval_ms: u64,
    /// How long a commit waits for `commit_result`.
    #[serde(default = "default_commit_timeout_ms")]
    pub commit_timeout_ms: u64,
    /// Component versions reported in the fleet hello.
    #[serde(default)]
    pub versions: VersionsConfig,
    /// Who may connect to nestd's proxy, runner and gateway sockets.
    #[serde(default)]
    pub sockets: SocketsConfig,
    /// Where clients reach this host's sandbox gateway (`ws://` or `wss://` base URL), reported in
    /// the fleet hello. `None` on a host that runs no sandboxes.
    #[serde(default)]
    pub gateway_url: Option<String>,
    /// The cloudflared binary. With it and a tunnel token from enrollment, nestd runs the host's
    /// Cloudflare Tunnel as a child (`cloudflared.rs`); without it, no tunnel.
    #[serde(default)]
    pub cloudflared_bin: Option<PathBuf>,
    /// Run cloudflared as this system user (`nest-cf` on real hosts), not as nestd. Unset, the
    /// child keeps nestd's own user (the harness). A name that does not exist fails startup.
    #[serde(default)]
    pub cloudflared_user: Option<String>,
    /// Where cloudflared serves its metrics and `/ready` (nestd polls it to report the tunnel's
    /// state). Default `127.0.0.1:18791`, next to the gateway's 18790; tests point it at a fake.
    #[serde(default)]
    pub cloudflared_metrics: Option<String>,
    /// Where generations (disk and memory chunks, manifests) go.
    #[serde(default)]
    pub storage: StorageConfig,
    /// nestd's systemd unit delegates its cgroup (`Delegate=yes`): at start nestd moves itself into
    /// the leaf `<own>/supervisor` and starts jailed VMMs under `<own>/vms`, so stopping or
    /// restarting the unit kills every VMM with it (`cgroup.rs`). Off: the jailer's default parent
    /// cgroup (outside the unit), where only nestd's start-up kill reaches leftovers.
    #[serde(default)]
    pub delegated_cgroup: bool,
    /// The cgroup v2 mount (tests point it elsewhere).
    #[serde(default = "default_cgroup_root")]
    pub cgroup_root: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StorageConfig {
    /// A directory on this host (`<state_dir>/store/<cell>`): development and tests.
    #[default]
    Local,
    /// The cell's S3 bucket, through the instance role; `<state_dir>/store/<cell>` is its cache.
    S3 {
        bucket: String,
        region: String,
        #[serde(default = "default_s3_prefix")]
        prefix: String,
        #[serde(default = "default_imds_url")]
        imds_url: String,
        /// Concurrent chunk transfers per commit or restore.
        #[serde(default = "default_s3_parallelism")]
        parallelism: usize,
        /// Cap on the local chunk cache (least recently used chunks go first).
        #[serde(default = "default_s3_cache_gib")]
        cache_max_gib: u64,
    },
}

/// Access control for the host-local control sockets (`proxy.sock`, `runner.sock`, `gateway.sock`). Whoever
/// connects receives secrets (the proxy CA key and injection secrets; OAuth and host tokens), so
/// the sockets are `0660` with an optional group, the peer uid is checked with `SO_PEERCRED`, and
/// only one peer is served at a time.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SocketsConfig {
    /// Group owning both sockets (e.g. the `nest` group shared by nest-proxy and the runner).
    #[serde(default)]
    pub gid: Option<u32>,
    /// Uids allowed to connect to `proxy.sock`. Empty: nestd's own euid and root only.
    #[serde(default)]
    pub proxy_uids: Vec<u32>,
    /// Uids allowed to connect to `runner.sock`. Empty: nestd's own euid and root only.
    #[serde(default)]
    pub runner_uids: Vec<u32>,
    /// Uids allowed to connect to `gateway.sock`. Empty: nestd's own euid and root only.
    #[serde(default)]
    pub gateway_uids: Vec<u32>,
    /// The gateway's own group (`nest-gw` on a host). It owns `gateway.sock` in place of `gid`,
    /// and each sandbox's vsock socket (`0660`) and jail root (`0710`, search only), so a gateway
    /// that runs as its own user can dial the guests (`driver/access.rs`). Unset: `gateway.sock`
    /// takes `gid`, and the vsock sockets keep the mode the VMM gave them, which only root and
    /// the VMM's user can connect to.
    #[serde(default)]
    pub gateway_gid: Option<u32>,
}

impl SocketsConfig {
    /// The group owning `gateway.sock`: the gateway's own, else the shared one.
    pub fn gateway_sock_gid(&self) -> Option<u32> {
        self.gateway_gid.or(self.gid)
    }

    /// Whether a peer with `uid` may use a socket whose allow-list is `allowed`.
    pub fn allows(allowed: &[u32], uid: u32) -> bool {
        if allowed.is_empty() {
            uid == 0 || uid == nix::unistd::geteuid().as_raw()
        } else {
            allowed.contains(&uid)
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EnrollmentConfig {
    /// Hosts outside AWS: single-use token minted by the operator, read from a file.
    TokenFile { path: PathBuf },
    /// AWS: IMDSv2 instance identity document + its `rsa2048` signature.
    AwsImds {
        #[serde(default = "default_imds_url")]
        imds_url: String,
    },
    /// Development/tests only: skip enrollment and use these credentials directly.
    Static { host: HostId, host_token: String, fleet_ws_url: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DriverConfig {
    /// Local development: runs the guest agent as a child process; vsock is emulated with unix
    /// sockets (see `docs/interfaces/host-guest/`).
    Process {
        guest_command: Vec<String>,
        /// Run the guest with its disk image loop-mounted at `/workspace` (root only).
        #[serde(default)]
        mount_disk: bool,
    },
    Firecracker(FirecrackerConfig),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FirecrackerConfig {
    pub firecracker_bin: PathBuf,
    /// When set, VMs are started through the jailer (`--netns` requires persisted netns paths).
    /// Without it Firecracker runs unjailed with nestd's privileges: development only.
    #[serde(default)]
    pub jailer_bin: Option<PathBuf>,
    /// Jailer settings (required when `jailer_bin` is set).
    #[serde(default)]
    pub jailer: Option<JailerConfig>,
    pub kernel_image: PathBuf,
    #[serde(default = "default_boot_args")]
    pub boot_args: String,
    /// Directory of base images: `<images_dir>/<image>.ext4`.
    pub images_dir: PathBuf,
    /// Cap each jailed VM's memory (cgroup v2 `memory.max`) at its declared size plus this much
    /// for the VMM itself, so a guest that outgrows its declaration dies alone instead of taking
    /// the host with it (regular pages are overcommitted: a guest costs only what it touches).
    #[serde(default = "default_vm_overhead_mib")]
    pub vm_memory_overhead_mib: u32,
    /// Back guest memory with 2 MiB hugetlbfs pages. Off by default: guest memory is regular
    /// pages, so a VM costs what it touches (`docs/sandbox/state/memory/`).
    #[serde(default)]
    pub huge_pages: bool,
}

/// Firecracker jailer settings: the VMM drops to `uid:gid` inside a chroot under
/// `<chroot_base_dir>/firecracker/<sandbox>/root`, into which the kernel and disk are hard-linked.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JailerConfig {
    pub uid: u32,
    pub gid: u32,
    #[serde(default = "default_chroot_base")]
    pub chroot_base_dir: PathBuf,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NetworkConfig {
    /// Per-sandbox netns with tap0, nft rules and proxy listeners (production).
    Netns {
        /// Bind-mount each netns to `<dir>/ns-<sandbox>` (needed by the Firecracker jailer).
        #[serde(default)]
        persist_dir: Option<PathBuf>,
    },
    /// No sandbox networking (tests, brain hosts).
    #[default]
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VersionsConfig {
    pub nest_proxy: String,
    pub agent_runner: String,
    pub claude_code: String,
}

impl Default for VersionsConfig {
    fn default() -> Self {
        Self { nest_proxy: "unknown".into(), agent_runner: "unknown".into(), claude_code: "unknown".into() }
    }
}

impl Config {
    /// What each host kind may configure. A sandbox host needs a driver. A brain host runs no
    /// sandbox, so nothing that serves one: no driver (no KVM or hugepages), no sandbox networking,
    /// no object store but the local one (it has no S3 access), no cloudflared and no gateway URL.
    /// Refused rather than ignored, so a bootstrap that mixes them up fails loudly at start.
    pub fn validate(&self) -> anyhow::Result<()> {
        match self.role {
            HostRole::Sandbox => {
                anyhow::ensure!(self.driver.is_some(), "a sandbox host needs a `driver`");
            }
            HostRole::Brain => {
                let mut extra = vec![];
                if self.driver.is_some() {
                    extra.push("driver");
                }
                if matches!(self.network, NetworkConfig::Netns { .. }) {
                    extra.push("network (netns)");
                }
                if matches!(self.storage, StorageConfig::S3 { .. }) {
                    extra.push("storage (s3)");
                }
                if self.cloudflared_bin.is_some() {
                    extra.push("cloudflared_bin");
                }
                if self.gateway_url.is_some() {
                    extra.push("gateway_url");
                }
                anyhow::ensure!(extra.is_empty(), "a brain host runs no sandboxes; remove {} from its config", extra.join(", "));
            }
        }
        Ok(())
    }

    pub fn flush_interval(&self) -> Duration {
        Duration::from_millis(self.flush_interval_ms)
    }
    pub fn commit_timeout(&self) -> Duration {
        Duration::from_millis(self.commit_timeout_ms)
    }
    /// `paths::PROXY_SOCK`, under `run_dir` (which tests and dev runs move).
    pub fn proxy_sock(&self) -> PathBuf {
        self.in_run_dir(paths::PROXY_SOCK)
    }
    /// `paths::RUNNER_SOCK`, under `run_dir`.
    pub fn runner_sock(&self) -> PathBuf {
        self.in_run_dir(paths::RUNNER_SOCK)
    }
    /// `paths::GATEWAY_SOCK`, under `run_dir`.
    pub fn gateway_sock(&self) -> PathBuf {
        self.in_run_dir(paths::GATEWAY_SOCK)
    }
    fn in_run_dir(&self, well_known: &str) -> PathBuf {
        let rel = Path::new(well_known).strip_prefix(paths::RUN_DIR).expect("a socket path under paths::RUN_DIR");
        self.run_dir.join(rel)
    }
    /// Per-VM runtime directory (sockets), one per incarnation: `<run_dir>/vm/<sandbox>/<epoch>`.
    pub fn vm_dir(&self, sandbox: &str, epoch: u64) -> PathBuf {
        self.vms_dir().join(sandbox).join(epoch.to_string())
    }
    pub fn vms_dir(&self) -> PathBuf {
        self.run_dir.join("vm")
    }
    /// One incarnation's state (disk, `meta.json`, snapshot): `<state_dir>/sandboxes/<sandbox>/<epoch>`.
    /// Incarnations never share files, so a newer epoch never waits on, or overwrites, an older one.
    pub fn sandbox_state_dir(&self, sandbox: &str, epoch: u64) -> PathBuf {
        self.sandboxes_dir().join(sandbox).join(epoch.to_string())
    }
    pub fn sandboxes_dir(&self) -> PathBuf {
        self.state_dir.join("sandboxes")
    }
    pub fn agents_dir(&self) -> PathBuf {
        self.state_dir.join("agents")
    }
    /// Saved host credentials (see `credentials.rs`).
    pub fn credentials_path(&self) -> PathBuf {
        self.state_dir.join("host-credentials.json")
    }
    pub fn store_dir(&self) -> PathBuf {
        self.state_dir.join("store").join(&self.cell)
    }
}

fn default_run_dir() -> PathBuf {
    paths::RUN_DIR.into()
}
fn default_cgroup_root() -> PathBuf {
    "/sys/fs/cgroup".into()
}
fn default_state_dir() -> PathBuf {
    "/var/lib/nest".into()
}
fn default_flush_ms() -> u64 {
    1_000
}
fn default_commit_timeout_ms() -> u64 {
    60_000
}
fn default_imds_url() -> String {
    "http://169.254.169.254".into()
}
fn default_s3_parallelism() -> usize {
    16
}
fn default_s3_cache_gib() -> u64 {
    8
}
fn default_s3_prefix() -> String {
    "store/".into()
}
/// No `init_on_free=1` until memory snapshots exist (its purpose): on a nested 8i host it makes a
/// 1-vCPU guest zero all of its memory at boot, which stalled boots past a minute (soft lockups in
/// `pgdatinit`, 2026-10-18).
fn default_boot_args() -> String {
    "console=ttyS0 reboot=k panic=1 pci=off".into()
}
fn default_chroot_base() -> PathBuf {
    "/srv/jailer".into()
}

fn default_vm_overhead_mib() -> u32 {
    128
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each host kind configures only what it runs: a sandbox host needs a driver; a brain host may
    /// name nothing a sandbox needs. The previous release's role names still parse.
    #[test]
    fn validates_what_each_host_kind_configures() {
        let parse = |v: serde_json::Value| serde_json::from_value::<Config>(v).unwrap();
        let brain = parse(serde_json::json!({"role": "brain", "cell": "c", "enrollment": {"type": "aws_imds"}}));
        assert_eq!(brain.role, HostRole::Brain);
        brain.validate().unwrap();
        let old = parse(serde_json::json!({"role": "controller", "cell": "c", "enrollment": {"type": "aws_imds"}}));
        assert_eq!(old.role, HostRole::Brain);
        let sandbox = parse(serde_json::json!({"role": "burst", "cell": "c", "enrollment": {"type": "aws_imds"}}));
        assert_eq!(sandbox.role, HostRole::Sandbox);
        assert!(sandbox.validate().unwrap_err().to_string().contains("needs a `driver`"));
        let mixed = parse(serde_json::json!({
            "role": "brain", "cell": "c", "enrollment": {"type": "aws_imds"},
            "driver": {"type": "process", "guest_command": ["g"]},
            "network": {"type": "netns"},
            "storage": {"type": "s3", "bucket": "b", "region": "r"},
            "cloudflared_bin": "/cf", "gateway_url": "ws://127.0.0.1:1"
        }));
        let e = mixed.validate().unwrap_err().to_string();
        for f in ["driver", "network (netns)", "storage (s3)", "cloudflared_bin", "gateway_url"] {
            assert!(e.contains(f), "{e}");
        }
    }

    /// The gateway's group owns `gateway.sock` when set, else the shared group does; it parses
    /// from a host's `sockets` block and is absent from an older config.
    #[test]
    fn gateway_group_owns_the_gateway_socket() {
        let s: SocketsConfig = serde_json::from_value(serde_json::json!({"gid": 1, "gateway_gid": 7, "gateway_uids": [8]})).unwrap();
        assert_eq!((s.gateway_sock_gid(), s.gateway_uids.as_slice()), (Some(7), &[8][..]));
        let old: SocketsConfig = serde_json::from_value(serde_json::json!({"gid": 1})).unwrap();
        assert_eq!((old.gateway_gid, old.gateway_sock_gid()), (None, Some(1)));
        assert_eq!(SocketsConfig::default().gateway_sock_gid(), None);
    }

    /// Guest memory is regular pages unless a config asks for hugepages (nestd review #8).
    #[test]
    fn huge_pages_default_off() {
        let fc: FirecrackerConfig =
            serde_json::from_value(serde_json::json!({"firecracker_bin": "/fc", "kernel_image": "/k", "images_dir": "/i"})).unwrap();
        assert!(!fc.huge_pages);
    }

    #[test]
    fn parses_minimal_config() {
        let cfg: Config = serde_json::from_value(serde_json::json!({
            "role": "sandbox",
            "cell": "aws-us-east-1",
            "enrollment": {"type": "aws_imds"},
            "driver": {"type": "process", "guest_command": ["nest-guest"]},
            "network": {"type": "netns", "persist_dir": "/run/netns"}
        }))
        .unwrap();
        assert_eq!(cfg.run_dir, PathBuf::from("/run/nest"));
        assert!(matches!(cfg.enrollment, EnrollmentConfig::AwsImds { ref imds_url } if imds_url == "http://169.254.169.254"));
        assert_eq!(cfg.proxy_sock(), PathBuf::from(paths::PROXY_SOCK));
        assert_eq!(cfg.runner_sock(), PathBuf::from(paths::RUNNER_SOCK));
        assert_eq!(cfg.gateway_sock(), PathBuf::from(paths::GATEWAY_SOCK));
        assert_eq!(cfg.agents_dir(), PathBuf::from(paths::AGENTS_DIR));
        assert!(matches!(cfg.storage, StorageConfig::Local));
        cfg.validate().unwrap();
        let s3: StorageConfig = serde_json::from_value(serde_json::json!({"type": "s3", "bucket": "b", "region": "us-east-1"})).unwrap();
        assert!(matches!(s3, StorageConfig::S3 { ref prefix, .. } if prefix == "store/"));
    }
}
