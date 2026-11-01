//! Test harness: a fake nestd over a real SEQPACKET socket, a test PKI, echo upstreams, and
//! clients that speak through the proxy's handed-over listeners.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::os::fd::{AsFd, OwnedFd};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use nix::sys::socket::{
    AddressFamily, Backlog, SockFlag, SockType, UnixAddr, accept, bind, listen, socket,
};
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose,
    PKCS_ECDSA_P256_SHA256,
};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use nest_protocol::control::CaCertificate;
use nest_protocol::host::fdpass::{self, MAX_PACKET_FROM_PROXY};
use nest_protocol::host::proxy::{ListenerPurpose, ListenerSpec, ProxyCommand, ProxyEvent, Transport};
use nest_protocol::host::{PROTOCOL_VERSION, Secret};
use nest_protocol::model::*;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

pub const PLACEHOLDER: &str = "nest-ph-github-test";
pub const SECRET: &str = "ghs_REAL_SECRET";

// ------------------------------------------------------------------------------------------
// PKI
// ------------------------------------------------------------------------------------------

fn ca_params(cn: &str) -> CertificateParams {
    let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, cn);
    p.distinguished_name = dn;
    p.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    p
}

pub struct Pki {
    /// What sandboxes trust (baked into the image).
    pub proxy_root: CertificateDer<'static>,
    pub install: CaCertificate,
    pub key_pem: String,
    /// "Public" CA for upstream servers (the proxy trusts it as an extra root).
    pub public_root: CertificateDer<'static>,
    public: CertifiedIssuer<'static, KeyPair>,
}

impl Pki {
    pub fn new() -> Self {
        let root = CertifiedIssuer::self_signed(ca_params("nest root"), KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap()).unwrap();
        let int_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let key_pem = int_key.serialize_pem();
        let int = ca_params("nest host intermediate").signed_by(&int_key, &root).unwrap();
        let public = CertifiedIssuer::self_signed(ca_params("public test CA"), KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap()).unwrap();
        Pki {
            proxy_root: root.der().clone(),
            install: CaCertificate {
                cert_pem: int.pem(),
                chain_pem: format!("{}{}", int.pem(), root.pem()),
                expires_ms: now_ms() + 86_400_000,
            },
            key_pem,
            public_root: public.der().clone(),
            public,
        }
    }

    /// Server cert for upstream hosts, signed by the public CA.
    pub fn upstream_cert(&self, hosts: &[&str]) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let params = CertificateParams::new(hosts.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        let cert = params.signed_by(&key, &self.public).unwrap();
        (vec![cert.der().clone(), self.public.der().clone()], PrivateKeyDer::from_pem_slice(key.serialize_pem().as_bytes()).unwrap())
    }
}

pub fn client_tls(roots: &[CertificateDer<'static>], alpn: &[&[u8]]) -> Arc<rustls::ClientConfig> {
    let mut store = rustls::RootCertStore::empty();
    for r in roots {
        store.add(r.clone()).unwrap();
    }
    let mut cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(store)
        .with_no_client_auth();
    cfg.alpn_protocols = alpn.iter().map(|a| a.to_vec()).collect();
    Arc::new(cfg)
}

// ------------------------------------------------------------------------------------------
// Upstreams
// ------------------------------------------------------------------------------------------

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Decode the echo's `authorization_hex` (what the upstream really received).
pub fn received_auth(body: &serde_json::Value) -> String {
    let h = body["authorization_hex"].as_str().expect("authorization_hex");
    let bytes: Vec<u8> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect();
    String::from_utf8(bytes).unwrap()
}

/// Echo handler: reports what the upstream actually received.
async fn echo(mut req: hyper::Request<hyper::body::Incoming>) -> Result<hyper::Response<Full<Bytes>>, std::convert::Infallible> {
    if req.headers().contains_key("upgrade") {
        let on = hyper::upgrade::on(&mut req);
        tokio::spawn(async move {
            let Ok(up) = on.await else { return };
            let mut io = TokioIo::new(up);
            let mut buf = [0u8; 1024];
            while let Ok(n) = io.read(&mut buf).await {
                if n == 0 || io.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        });
        let mut r = hyper::Response::new(Full::new(Bytes::new()));
        *r.status_mut() = hyper::StatusCode::SWITCHING_PROTOCOLS;
        r.headers_mut().insert("connection", "upgrade".parse().unwrap());
        r.headers_mut().insert("upgrade", "websocket".parse().unwrap());
        return Ok(r);
    }
    let host = req
        .uri()
        .authority()
        .map(|a| a.to_string())
        .or_else(|| req.headers().get("host").map(|h| h.to_str().unwrap().to_string()));
    let v = serde_json::json!({
        "host": host,
        "path": req.uri().path_and_query().map(|p| p.to_string()),
        "authorization": req.headers().get("authorization").map(|h| h.to_str().unwrap().to_string()),
        // Hex-encoded too: the proxy masks injected secrets that upstreams echo back, so tests
        // read what the upstream *received* from this field.
        "authorization_hex": req.headers().get("authorization").map(|h| hex(h.as_bytes())),
        "host_headers": req.headers().get_all("host").iter().map(|h| h.to_str().unwrap().to_string()).collect::<Vec<_>>(),
        "te": req.headers().get("te").map(|h| h.to_str().unwrap().to_string()),
        "method": req.method().as_str(),
        "version": format!("{:?}", req.version()),
        "proxy_authorization": req.headers().get("proxy-authorization").is_some(),
    });
    let body = req.into_body().collect().await.map(|b| b.to_bytes().len()).unwrap_or(0);
    let mut v = v;
    v["body_len"] = body.into();
    Ok(hyper::Response::new(Full::new(Bytes::from(v.to_string()))))
}

pub async fn tls_upstream(pki: &Pki, hosts: &[&str]) -> SocketAddr {
    let (chain, key) = pki.upstream_cert(hosts);
    let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .unwrap();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(s).await else { return };
                let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new())
                    .serve_connection_with_upgrades(TokioIo::new(tls), service_fn(echo))
                    .await;
            });
        }
    });
    addr
}

pub async fn plain_upstream() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(s), service_fn(echo)).await;
            });
        }
    });
    addr
}

pub async fn tcp_echo() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut s, _) = l.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}

// ------------------------------------------------------------------------------------------
// Fake nestd
// ------------------------------------------------------------------------------------------

pub struct FakeNestd {
    listen: OwnedFd,
    pub path: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

pub struct NestdConn {
    fd: Arc<OwnedFd>,
    pub events: mpsc::UnboundedReceiver<ProxyEvent>,
}

impl FakeNestd {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy.sock");
        let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None).unwrap();
        bind(std::os::fd::AsRawFd::as_raw_fd(&fd), &UnixAddr::new(&path).unwrap()).unwrap();
        listen(&fd, Backlog::new(4).unwrap()).unwrap();
        FakeNestd { listen: fd, path, _dir: dir }
    }

    /// Accept the proxy's next connection and start pumping its events.
    pub async fn accept(&self) -> NestdConn {
        let raw = std::os::fd::AsRawFd::as_raw_fd(&self.listen);
        let fd = tokio::task::spawn_blocking(move || accept(raw).unwrap()).await.unwrap();
        // SAFETY: accept returned a fresh descriptor we now own.
        let fd: OwnedFd = unsafe { std::os::fd::FromRawFd::from_raw_fd(fd) };
        let fd = Arc::new(fd);
        let (tx, rx) = mpsc::unbounded_channel();
        let rfd = fd.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            while let Ok(Some((ev, _fds))) = fdpass::recv::<ProxyEvent>(rfd.as_fd(), &mut buf, MAX_PACKET_FROM_PROXY) {
                if tx.send(ev).is_err() {
                    break;
                }
            }
        });
        NestdConn { fd, events: rx }
    }
}

impl NestdConn {
    pub fn send(&self, cmd: &ProxyCommand, fds: &[&OwnedFd]) {
        let b: Vec<_> = fds.iter().map(|f| f.as_fd()).collect();
        fdpass::send(self.fd.as_fd(), cmd, &b).unwrap();
    }

    /// Next event matching `pred`, skipping others (audit noise etc.).
    pub async fn wait(&mut self, mut pred: impl FnMut(&ProxyEvent) -> bool) -> ProxyEvent {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let ev = self.events.recv().await.expect("proxy disconnected");
                if pred(&ev) {
                    return ev;
                }
            }
        })
        .await
        .expect("timed out waiting for proxy event")
    }

    pub fn shutdown(&self) {
        nix::sys::socket::shutdown(std::os::fd::AsRawFd::as_raw_fd(&*self.fd), nix::sys::socket::Shutdown::Both).unwrap();
    }
}

// ------------------------------------------------------------------------------------------
// One sandbox's network as nestd would set it up (here on 127.0.0.1)
// ------------------------------------------------------------------------------------------

pub struct Net {
    pub dns_udp: std::net::UdpSocket,
    pub dns_tcp: std::net::TcpListener,
    pub http: std::net::TcpListener,
    pub https: std::net::TcpListener,
    pub explicit: std::net::TcpListener,
    pub tcp_exc: std::net::TcpListener,
}

impl Net {
    pub fn bind() -> Self {
        Net {
            dns_udp: std::net::UdpSocket::bind("127.0.0.1:0").unwrap(),
            dns_tcp: std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            http: std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            https: std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            explicit: std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
            tcp_exc: std::net::TcpListener::bind("127.0.0.1:0").unwrap(),
        }
    }
    pub fn https_addr(&self) -> SocketAddr {
        self.https.local_addr().unwrap()
    }
    pub fn explicit_addr(&self) -> SocketAddr {
        self.explicit.local_addr().unwrap()
    }

    /// Specs + dup'd fds (nestd keeps its own copies).
    pub fn handoff(&self, db_port: u16) -> (Vec<ListenerSpec>, Vec<OwnedFd>) {
        let spec = |id, transport, addr: SocketAddr, purpose| ListenerSpec { id, transport, addr: addr.to_string(), purpose };
        let specs = vec![
            spec(1, Transport::Udp, self.dns_udp.local_addr().unwrap(), ListenerPurpose::Dns),
            spec(2, Transport::Tcp, self.dns_tcp.local_addr().unwrap(), ListenerPurpose::Dns),
            spec(3, Transport::Tcp, self.http.local_addr().unwrap(), ListenerPurpose::HttpTransparent),
            spec(4, Transport::Tcp, self.https_addr(), ListenerPurpose::HttpsTransparent),
            spec(5, Transport::Tcp, self.explicit_addr(), ListenerPurpose::Explicit { agent: AgentId("agt_test".into()), slot: 0 }),
            spec(6, Transport::Tcp, self.tcp_exc.local_addr().unwrap(), ListenerPurpose::TcpException { rule: format!("db.test:{db_port}") }),
        ];
        let fds = vec![
            OwnedFd::from(self.dns_udp.try_clone().unwrap()),
            OwnedFd::from(self.dns_tcp.try_clone().unwrap()),
            OwnedFd::from(self.http.try_clone().unwrap()),
            OwnedFd::from(self.https.try_clone().unwrap()),
            OwnedFd::from(self.explicit.try_clone().unwrap()),
            OwnedFd::from(self.tcp_exc.try_clone().unwrap()),
        ];
        (specs, fds)
    }
}

pub fn sandbox() -> SandboxId {
    SandboxId("sbx_test".into())
}

pub fn policy(version: u64, db_port: u16) -> EgressPolicy {
    let allow = |h: &str, ports: Vec<u16>| AllowRule { host: HostPattern(h.into()), ports, layer: PolicyLayer::Base, expires_ms: None };
    EgressPolicy {
        version,
        allow: vec![
            allow("api.github.test", vec![443]),
            allow("api.stripe.test", vec![443]),
            allow("pinned.test", vec![443]),
            allow("private.test", vec![443]),
            allow("plain.test", vec![80]),
        ],
        passthrough: vec![HostPattern("pinned.test".into())],
        inject: vec![InjectionBinding {
            name: "github".into(),
            hosts: vec![HostPattern("api.github.test".into())],
            placeholder: PLACEHOLDER.into(),
            locations: vec![InjectionLocation::AuthorizationBearer, InjectionLocation::AuthorizationBasicPassword],
        }],
        tcp: vec![TcpException { host: "db.test".into(), port: db_port }],
        limits: EgressLimits { max_connections: 64, bandwidth_mbps: 100, max_inspected_body_bytes: 1 << 20 },
        guards: vec![],
    }
}

pub fn secrets(expires_ms: Option<i64>) -> Vec<InjectionSecret> {
    vec![InjectionSecret { binding: "github".into(), value: SECRET.into(), expires_ms }]
}

/// Full resync of one sandbox, as nestd does on every (re)connect.
pub async fn resync(conn: &mut NestdConn, pki: &Pki, net: &Net, secret_expiry: Option<i64>, db_port: u16) {
    let hello = conn.wait(|e| matches!(e, ProxyEvent::Hello { .. })).await;
    assert!(matches!(hello, ProxyEvent::Hello { protocol_version: PROTOCOL_VERSION, .. }));
    conn.send(&ProxyCommand::HelloAck { protocol_version: PROTOCOL_VERSION, host_id: HostId("hst_test".into()), nestd_boot_id: "boot".into() }, &[]);
    conn.send(&ProxyCommand::CaInstall { ca: pki.install.clone(), key_pem: Secret(pki.key_pem.clone()) }, &[]);
    conn.send(&ProxyCommand::LeaseUpdate { valid_until_ms: now_ms() + 60_000 }, &[]);
    conn.send(&ProxyCommand::SandboxUpsert { sandbox: sandbox(), epoch: Epoch(4), workstream: None, policy: policy(1, db_port) }, &[]);
    conn.send(&ProxyCommand::SecretsSet { sandbox: sandbox(), epoch: Epoch(4), secrets: secrets(secret_expiry) }, &[]);
    let (specs, fds) = net.handoff(db_port);
    let refs: Vec<&OwnedFd> = fds.iter().collect();
    conn.send(&ProxyCommand::ListenersAdd { sandbox: sandbox(), epoch: Epoch(4), listeners: specs }, &refs);
    conn.send(&ProxyCommand::ResyncComplete { sandboxes: 1, listeners: 6 }, &[]);
    let ack = conn.wait(|e| matches!(e, ProxyEvent::ResyncAck { .. })).await;
    assert_eq!(ack, ProxyEvent::ResyncAck { sandboxes: 1, listeners: 6 });
}

// ------------------------------------------------------------------------------------------
// The environment
// ------------------------------------------------------------------------------------------

pub struct Env {
    pub pki: Pki,
    pub nestd: FakeNestd,
    pub conn: NestdConn,
    pub net: Net,
    pub echo_addr: SocketAddr,
}

pub async fn env_with(secret_expiry: Option<i64>, allow_private: bool) -> Env {
    let _ = tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).with_test_writer().try_init();
    let pki = Pki::new();
    let up = tls_upstream(&pki, &["api.github.test", "api.stripe.test", "pinned.test", "private.test"]).await;
    let plain = plain_upstream().await;
    let echo_addr = tcp_echo().await;
    let resolver = nest_proxy::StaticResolver::new()
        .insert("api.github.test", up)
        .insert("api.stripe.test", up)
        .insert("pinned.test", up)
        .insert("private.test", up)
        .insert("plain.test", plain)
        .insert("db.test", std::net::SocketAddr::new(echo_addr.ip(), 0));
    let nestd = FakeNestd::new();
    let mut cfg = nest_proxy::Config::new(&nestd.path);
    cfg.resolver = Arc::new(resolver);
    cfg.webpki_roots = false;
    cfg.extra_roots = vec![pki.public_root.clone()];
    cfg.allow_private_upstreams = allow_private;
    tokio::spawn(async move {
        nest_proxy::run(cfg).await.unwrap();
    });
    let mut conn = nestd.accept().await;
    let net = Net::bind();
    resync(&mut conn, &pki, &net, secret_expiry, echo_addr.port()).await;
    Env { pki, nestd, conn, net, echo_addr }
}

pub async fn env() -> Env {
    env_with(None, true).await
}

// ------------------------------------------------------------------------------------------
// Clients
// ------------------------------------------------------------------------------------------

pub struct Resp {
    pub status: u16,
    pub body: serde_json::Value,
}

/// HTTP request over an already-established (TLS) stream.
pub async fn http_over<S>(io: S, h2: bool, method: &str, host: &str, path: &str, headers: &[(&str, &str)]) -> Resp
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    http_over_body(io, h2, method, host, path, headers, Bytes::from_static(b"hello")).await
}

/// [`http_over`] with a body of its own.
pub async fn http_over_body<S>(io: S, h2: bool, method: &str, host: &str, path: &str, headers: &[(&str, &str)], body: Bytes) -> Resp
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut b = hyper::Request::builder().method(method);
    if h2 {
        b = b.uri(format!("https://{host}{path}"));
    } else {
        b = b.uri(path).header("host", host);
    }
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let req = b.body(Full::new(body)).unwrap();
    let resp = if h2 {
        let (mut s, conn) = hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(io)).await.unwrap();
        tokio::spawn(conn);
        s.send_request(req).await.unwrap()
    } else {
        let (mut s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.unwrap();
        tokio::spawn(conn);
        s.send_request(req).await.unwrap()
    };
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
    Resp { status, body }
}

pub async fn tls_connect(
    addr: SocketAddr,
    sni: &str,
    roots: &[CertificateDer<'static>],
    alpn: &[&[u8]],
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let tcp = TcpStream::connect(addr).await?;
    tokio_rustls::TlsConnector::from(client_tls(roots, alpn))
        .connect(ServerName::try_from(sni.to_string()).unwrap(), tcp)
        .await
}

/// Transparent HTTPS through the `:443` listener.
pub async fn https_get(env: &Env, sni: &str, host_header: &str, headers: &[(&str, &str)], h2: bool) -> Resp {
    let alpn: &[&[u8]] = if h2 { &[b"h2"] } else { &[b"http/1.1"] };
    let tls = tls_connect(env.net.https_addr(), sni, std::slice::from_ref(&env.pki.proxy_root), alpn).await.expect("tls to proxy");
    http_over(tls, h2, "GET", host_header, "/x?q=1", headers).await
}

/// Open a CONNECT tunnel through the explicit listener; returns the raw stream and status line.
pub async fn connect_tunnel(env: &Env, authority: &str) -> (TcpStream, String) {
    let mut s = TcpStream::connect(env.net.explicit_addr()).await.unwrap();
    s.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes()).await.unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8_lossy(&head).to_string();
    (s, text)
}

/// One transparent HTTPS request with any method, path and body.
pub async fn https_req(env: &Env, host: &str, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8], h2: bool) -> Resp {
    let alpn: &[&[u8]] = if h2 { &[b"h2"] } else { &[b"http/1.1"] };
    let tls = tls_connect(env.net.https_addr(), host, std::slice::from_ref(&env.pki.proxy_root), alpn).await.expect("tls to proxy");
    http_over_body(tls, h2, method, host, path, headers, Bytes::copy_from_slice(body)).await
}
