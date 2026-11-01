//! nest-proxy: the only egress path out of a sandbox.
//!
//! An unprivileged process. nestd binds listening sockets inside each sandbox netns and hands them
//! over a SEQPACKET control socket (`nest_protocol::host::proxy`); the proxy never calls `setns`.
//! It is a stateless cache of nestd's state and fails closed whenever nestd or the host lease is
//! gone. See `docs/sandbox/networking/egress/` and `docs/interfaces/host-internal/nestd-proxy/`.

pub mod audit;
pub mod control;
pub mod dns;
pub mod guard;
pub mod http;
pub mod inject;
pub mod listener;
pub mod resolve;
pub mod sni;
pub mod state;
pub mod tls;
pub mod util;

use std::path::PathBuf;
use std::sync::Arc;

use rustls_pki_types::CertificateDer;

pub use control::run;
pub use resolve::{Resolve, StaticResolver, SystemResolver};

/// Process-wide configuration (everything else arrives from nestd).
#[derive(Clone)]
pub struct Config {
    /// nestd's SEQPACKET control socket.
    pub nestd_sock: PathBuf,
    /// Upstream name resolution, used both for DNS answers and for re-resolving SNI/Host.
    pub resolver: Arc<dyn Resolve>,
    /// Trust the Mozilla roots (webpki-roots) for upstream verification.
    pub webpki_roots: bool,
    /// Additional upstream trust anchors (tests, private upstreams).
    pub extra_roots: Vec<CertificateDer<'static>>,
    /// Permit loopback/private upstream addresses. Tests only: in production this would expose
    /// IMDS and the VPC to sandboxes through policy names that resolve there.
    pub allow_private_upstreams: bool,
}

impl Config {
    pub fn new(nestd_sock: impl Into<PathBuf>) -> Self {
        Config {
            nestd_sock: nestd_sock.into(),
            resolver: Arc::new(SystemResolver),
            webpki_roots: true,
            extra_roots: Vec::new(),
            allow_private_upstreams: false,
        }
    }
}
