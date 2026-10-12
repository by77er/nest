//! Upstream name resolution. The proxy always resolves names itself (never trusting the IP a
//! guest dialed), and DNS answers to guests come from the same resolver.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;

pub type ResolveFuture<'a> = Pin<Box<dyn Future<Output = io::Result<Vec<SocketAddr>>> + Send + 'a>>;

pub trait Resolve: Send + Sync + 'static {
    /// Resolve `host` to socket addresses for `port`.
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a>;
}

/// The host's system resolver (getaddrinfo via tokio).
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            let mut out: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await?.collect();
            out.dedup();
            Ok(out)
        })
    }
}

/// Fixed name → address table (tests, or pinned private upstreams). The table's port wins over
/// the requested one when set (non-zero), so tests can map `api.github.test:443` to an ephemeral
/// local server.
#[derive(Default)]
pub struct StaticResolver {
    entries: HashMap<String, Vec<SocketAddr>>,
}

impl StaticResolver {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(mut self, host: &str, addr: SocketAddr) -> Self {
        self.entries.entry(host.to_ascii_lowercase()).or_default().push(addr);
        self
    }
}

impl Resolve for StaticResolver {
    fn resolve<'a>(&'a self, host: &'a str, port: u16) -> ResolveFuture<'a> {
        Box::pin(async move {
            match self.entries.get(&host.trim_end_matches('.').to_ascii_lowercase()) {
                Some(addrs) => Ok(addrs
                    .iter()
                    .map(|a| if a.port() == 0 { SocketAddr::new(a.ip(), port) } else { *a })
                    .collect()),
                None => Err(io::Error::new(io::ErrorKind::NotFound, format!("no such host: {host}"))),
            }
        })
    }
}
