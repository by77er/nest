//! nestd: the privileged per-host daemon. See `docs/compute/nestd/` and `crates/nestd/README.md`.

pub mod cgroup;
pub mod cloudflared;
pub mod config;
pub mod credentials;
pub mod driver;
pub mod enroll;
pub mod fleet;
pub mod gateway_link;
pub mod gc;
pub mod guest;
pub mod host;
pub mod limits;
pub mod net;
pub mod proxy_link;
pub mod recovery;
pub mod runner_link;
pub mod s3;
pub mod storage;
pub mod tombstones;
pub mod util;
pub mod vsock;

/// What this nestd supports that a host's install scripts must know before they configure it,
/// printed one per line by `nestd --features` (`deploy/host/install.sh` and `bootstrap.sh` read
/// it; `scripts/publish-release.sh` checks the release build prints it). A nestd that predates
/// the flag exits non-zero, which the scripts read as "none".
/// - `gateway-user`: `sockets.gateway_gid`, so the gateway can run as its own user.
pub const FEATURES: &[&str] = &["gateway-user"];
