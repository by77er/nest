//! HTTP(S) handling: transparent `:443` (SNI-routed) and `:80`, the per-agent explicit proxy
//! (CONNECT + absolute-form), TLS inspection with credential injection, passthrough splicing,
//! and upstream connections (always re-resolved by the proxy, verified, and fail-closed).

use std::convert::Infallible;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{CONNECTION, HOST, TE, UPGRADE};
use http::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use http_body_util::{BodyExt, Full, Limited, combinators::BoxBody};
use hyper::body::{Body as HttpBody, Frame, Incoming, SizeHint};
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::{TlsAcceptor, TlsConnector};

use nest_protocol::control::EgressVerdict;
use nest_protocol::host::proxy::AlertKind;
use nest_protocol::model::EgressDecision;

use crate::audit::Audit;
use crate::guard;
use crate::inject::{self, Verdict};
use crate::sni::{ClientHelloInfo, read_client_hello};
use crate::state::ConnCtx;
use crate::tls::supported_alpn;
use crate::util::{Prefixed, clip, mask_all, norm_host, now_ms, split_authority, valid_host};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Hop-by-hop headers never forwarded (RFC 9110 §7.6.1), plus proxy credentials.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "proxy-connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
];

// ---------------------------------------------------------------------------------------------
// Entry points (one per listener purpose)
// ---------------------------------------------------------------------------------------------

/// `:443` via nft redirect: route by SNI.
pub async fn serve_https_transparent(ctx: Arc<ConnCtx>, mut s: TcpStream) {
    let (raw, info) = match read_client_hello(&mut s, HELLO_TIMEOUT).await {
        Ok(v) => v,
        Err(e) => return tracing::debug!("https transparent: {e}"),
    };
    let Some(info) = info else {
        ctx.audit(Audit::new("", 443, EgressVerdict::Deny).reason("not_tls"));
        return;
    };
    let Some(sni) = info.sni.clone() else {
        ctx.audit(Audit::new("", 443, EgressVerdict::Deny).reason("no_sni"));
        return;
    };
    let host = norm_host(&sni);
    if !valid_host(&host) {
        ctx.audit(Audit::new(&host, 443, EgressVerdict::Deny).reason("invalid_host"));
        return;
    }
    tls_flow(ctx, Prefixed::new(raw, s), host, 443, info).await;
}

/// HTTP/1.1 listeners: `:80` via nft redirect (plaintext, routed per request by `Host`), or with
/// `explicit`, `:3128 + slot`, the per-agent explicit proxy (CONNECT tunnels and absolute-form HTTP).
pub async fn serve_h1(ctx: Arc<ConnCtx>, s: TcpStream, explicit: bool) {
    let drop = ctx.sandbox.drop.clone();
    let svc = service_fn(move |req| {
        let ctx = ctx.clone();
        async move {
            let resp = if explicit { explicit_request(ctx, req).await } else { plain_request(ctx, req, false).await };
            Ok::<_, Infallible>(resp)
        }
    });
    let conn = hyper::server::conn::http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(TokioIo::new(s), svc)
        .with_upgrades();
    tokio::select! { _ = drop.cancelled() => {}, r = conn => if let Err(e) = r { tracing::debug!(explicit, "http/1.1 listener: {e}") } }
}

/// `:20000 + n`: raw TCP to one `host:port`, only to addresses our resolver returned.
pub async fn serve_tcp_exception(ctx: Arc<ConnCtx>, s: TcpStream, rule: String) {
    let (host, port) = split_authority(&rule, 0);
    let host = norm_host(&host);
    let view = ctx.view();
    let permitted = view.policy.as_ref().is_some_and(|p| p.tcp_exception(&host, port));
    if !permitted || port == 0 {
        ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("tcp_exception_not_in_policy"));
        return;
    }
    let mut ips = ctx.sandbox.dns_ips(&host);
    if ips.is_empty() {
        // Resolve through our own resolver (the same one that answers the sandbox) and record it.
        match ctx.session.upstream.resolve(&host, port).await {
            Ok(addrs) => {
                ips = addrs.iter().map(|a| a.ip()).collect();
                ctx.sandbox.record_dns(&host, &ips);
            }
            Err(e) => {
                ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason(format!("resolve: {e}")));
                return;
            }
        }
    }
    let addrs: Vec<SocketAddr> = ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect();
    match connect_addrs(&ctx, &addrs).await {
        Ok(up) => splice(&ctx, s, up, &host, port, EgressVerdict::Allow, Some("tcp_exception")).await,
        Err(e) => ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason(format!("connect: {e}"))),
    }
}

// ---------------------------------------------------------------------------------------------
// TLS: decide → deny / passthrough / inspect
// ---------------------------------------------------------------------------------------------

async fn tls_flow<S>(ctx: Arc<ConnCtx>, client: Prefixed<S>, host: String, port: u16, info: ClientHelloInfo)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let decision = decide(&ctx, &host, port);
    match decision {
        EgressDecision::Deny => {
            ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("not_allowed"));
            deny_tls(&ctx, client, &host, port, &info, "not in this sandbox's egress policy").await;
        }
        EgressDecision::Passthrough => match connect_host(&ctx, &host, port).await {
            Ok(up) => splice(&ctx, client, up, &host, port, EgressVerdict::Passthrough, None).await,
            Err(e) => ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason(format!("connect: {e}"))),
        },
        EgressDecision::Inspect => inspect_tls(ctx, client, host, port, info).await,
    }
}

fn decide(ctx: &ConnCtx, host: &str, port: u16) -> EgressDecision {
    if !ctx.live() {
        return EgressDecision::Deny;
    }
    match ctx.view().policy {
        Some(p) => p.decide(host, port, now_ms()),
        None => EgressDecision::Deny,
    }
}

/// Terminate TLS just to deliver a readable 403 (needs the CA; otherwise just close).
async fn deny_tls<S>(ctx: &ConnCtx, client: S, host: &str, port: u16, info: &ClientHelloInfo, reason: &'static str)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(ca) = ctx.session.ca() else { return };
    let Ok(cfg) = ca.server_config(host, supported_alpn(&info.alpn)) else { return };
    let Ok(Ok(tls)) = tokio::time::timeout(HELLO_TIMEOUT, TlsAcceptor::from(cfg).accept(client)).await else { return };
    let (host, reason) = (host.to_string(), reason.to_string());
    let svc = service_fn(move |_req: Request<Incoming>| {
        let r = deny_response(StatusCode::FORBIDDEN, "egress_denied", &host, port, &reason);
        async move { Ok::<_, Infallible>(r) }
    });
    let _ = tokio::time::timeout(
        Duration::from_secs(30),
        hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(tls), svc),
    )
    .await;
}

async fn inspect_tls<S>(ctx: Arc<ConnCtx>, client: Prefixed<S>, host: String, port: u16, info: ClientHelloInfo)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(ca) = ctx.session.ca() else {
        ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("no_ca"));
        return;
    };
    // Upstream first: its negotiated ALPN is what we offer the client (mirroring).
    let offer = supported_alpn(&info.alpn);
    let upstream = match connect_tls(&ctx, &host, port, &offer).await {
        Ok(u) => u,
        Err(e) => {
            // Fail closed: tell the client why, over our own TLS.
            ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason(format!("upstream: {e}")));
            deny_tls(&ctx, client, &host, port, &info, "upstream connection or certificate verification failed").await;
            return;
        }
    };
    let h2 = upstream.get_ref().1.alpn_protocol() == Some(b"h2");
    let server_alpn = upstream.get_ref().1.alpn_protocol().map(|p| vec![p.to_vec()]).unwrap_or_default();
    let cfg = match ca.server_config(&host, server_alpn) {
        Ok(c) => c,
        Err(e) => return tracing::warn!("leaf for {host}: {e}"),
    };
    let tls = match tokio::time::timeout(HELLO_TIMEOUT, TlsAcceptor::from(cfg).accept(client)).await {
        Ok(Ok(t)) => t,
        _ => return,
    };
    let target = Arc::new(Target { host, port, tls: true });
    let conn = match UpstreamConn::from_tls(ctx.clone(), target.clone(), upstream, h2).await {
        Ok(c) => Arc::new(c),
        Err(e) => return tracing::debug!("upstream handshake: {e}"),
    };
    let drop = ctx.sandbox.drop.clone();
    let svc = service_fn(move |req| {
        let (ctx, target, conn) = (ctx.clone(), target.clone(), conn.clone());
        async move { Ok::<_, Infallible>(forward(ctx, &target, &conn, req).await) }
    });
    let io = TokioIo::new(tls);
    let res = if h2 {
        let fut = hyper::server::conn::http2::Builder::new(TokioExecutor::new()).serve_connection(io, svc);
        tokio::select! { _ = drop.cancelled() => Ok(()), r = fut => r }
    } else {
        let fut = hyper::server::conn::http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(HEADER_TIMEOUT)
            .serve_connection(io, svc)
            .with_upgrades();
        tokio::select! { _ = drop.cancelled() => Ok(()), r = fut => r }
    };
    if let Err(e) = res {
        tracing::debug!("inspect serve: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// Explicit proxy
// ---------------------------------------------------------------------------------------------

async fn explicit_request(ctx: Arc<ConnCtx>, req: Request<Incoming>) -> Response<Body> {
    if req.method() == Method::CONNECT {
        let Some(auth) = req.uri().authority().cloned() else {
            return simple(StatusCode::BAD_REQUEST, "CONNECT needs host:port");
        };
        let (host, port) = split_authority(auth.as_str(), 443);
        let host = norm_host(&host);
        if !valid_host(&host) || port == 0 {
            ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("invalid_host"));
            return simple(StatusCode::BAD_REQUEST, "CONNECT target is not a valid host:port");
        }
        let decision = decide(&ctx, &host, port);
        if decision == EgressDecision::Deny {
            ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("not_allowed"));
        }
        // Even a denied CONNECT is accepted, then answered *inside* the tunnel (a 403 over our TLS,
        // or a plaintext 403): clients like curl hide a CONNECT error body, and the readable
        // reason is what lets an agent ask for access. Nothing reaches upstream.
        tokio::spawn(async move {
            match hyper::upgrade::on(req).await {
                Ok(up) => tunnel(ctx, TokioIo::new(up), host, port, decision).await,
                Err(e) => tracing::debug!("CONNECT upgrade: {e}"),
            }
        });
        return Response::new(empty());
    }
    if req.uri().scheme_str() == Some("http") && req.uri().authority().is_some() {
        return plain_request(ctx, req, true).await;
    }
    simple(StatusCode::BAD_REQUEST, "explicit proxy expects CONNECT or absolute-form http:// requests")
}

/// Every CONNECT tunnel must carry TLS whose SNI (if any) names the CONNECT authority; the
/// decision itself is re-made from that name in [`tls_flow`]. Plaintext tunnels are denied: they
/// would bypass the Host checks and placeholder rules of the inspected path (plain HTTP goes
/// through absolute-form requests instead).
async fn tunnel<S>(ctx: Arc<ConnCtx>, mut io: S, host: String, port: u16, decision: EgressDecision)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (raw, info) = match read_client_hello(&mut io, HELLO_TIMEOUT).await {
        Ok(v) => v,
        Err(e) => return tracing::debug!("tunnel hello: {e}"),
    };
    let Some(info) = info else {
        if decision != EgressDecision::Deny {
            ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("non_tls_tunnel"));
        }
        let reason = if decision == EgressDecision::Deny {
            "not in this sandbox's egress policy"
        } else {
            "CONNECT tunnels must carry TLS; send plain HTTP as an absolute-form request to the proxy"
        };
        write_raw_deny(io, &host, port, reason).await;
        return;
    };
    if let Some(sni) = &info.sni
        && norm_host(sni) != host
    {
        ctx.alert(AlertKind::DomainFronting, &host, None, format!("CONNECT {host} but SNI {}", clip(sni, 256)));
        ctx.audit(Audit::new(&host, port, EgressVerdict::Alert).reason("sni_mismatch"));
        return;
    }
    if decision == EgressDecision::Deny {
        // Already audited by the CONNECT handler; deliver the readable 403 over our TLS.
        deny_tls(&ctx, Prefixed::new(raw, io), &host, port, &info, "not in this sandbox's egress policy").await;
        return;
    }
    tls_flow(ctx, Prefixed::new(raw, io), host, port, info).await;
}

/// Plaintext HTTP 403 written straight onto a raw tunnel, then closed.
async fn write_raw_deny<S: AsyncWrite + Unpin>(mut io: S, host: &str, port: u16, reason: &str) {
    let body = deny_json("egress_denied", host, port, reason).to_string();
    let head = format!(
        "HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: {}\r\nx-nest-proxy: 1\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        io.write_all(head.as_bytes()).await?;
        io.write_all(body.as_bytes()).await?;
        io.shutdown().await
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// Plaintext HTTP (transparent :80 and absolute-form via the explicit proxy)
// ---------------------------------------------------------------------------------------------

async fn plain_request(ctx: Arc<ConnCtx>, req: Request<Incoming>, absolute: bool) -> Response<Body> {
    let authority = if absolute {
        req.uri().authority().map(|a| a.to_string())
    } else {
        req.headers().get(HOST).and_then(|h| h.to_str().ok()).map(str::to_string)
    };
    let Some(authority) = authority else { return simple(StatusCode::BAD_REQUEST, "missing Host") };
    let (host, port) = split_authority(&authority, 80);
    let host = norm_host(&host);
    if !valid_host(&host) || port == 0 {
        ctx.audit(Audit::new(&host, port, EgressVerdict::Deny).reason("invalid_host"));
        return simple(StatusCode::BAD_REQUEST, "request target is not a valid host");
    }
    let target = Arc::new(Target { host, port, tls: false });
    let conn = UpstreamConn::lazy(ctx.clone(), target.clone(), false);
    forward(ctx, &target, &conn, req).await
}

// ---------------------------------------------------------------------------------------------
// Request forwarding (host check, injection, upgrades, audit)
// ---------------------------------------------------------------------------------------------

pub struct Target {
    pub host: String,
    pub port: u16,
    pub tls: bool,
}

async fn forward(ctx: Arc<ConnCtx>, target: &Target, up: &UpstreamConn, req: Request<Incoming>) -> Response<Body> {
    // Boxed now: a guard that reads the body puts back a replaying one.
    let mut req: Request<Body> = req.map(|b| b.map_err(|e| Box::new(e) as BoxError).boxed());
    let mk_audit = |req: &Request<Body>, v: EgressVerdict| Audit::new(&target.host, target.port, v).request(req.method(), req.uri());

    // Decided per request: a push or a grant's expiry since admission may have revoked the host,
    // or made it passthrough-only, which an inspected connection can't honour.
    let decision = decide(&ctx, &target.host, target.port);
    if decision == EgressDecision::Deny || (target.tls && decision == EgressDecision::Passthrough) {
        ctx.audit(mk_audit(&req, EgressVerdict::Deny).reason("not_allowed"));
        return deny_response(StatusCode::FORBIDDEN, "egress_denied", &target.host, target.port, "not in this sandbox's egress policy");
    }

    // Every name the request carries must be the routed host (SNI / CONNECT authority / the
    // Host that routed a plaintext request) — no domain fronting via absolute-form targets or
    // extra Host headers. The upstream later gets a Host we set ourselves.
    if let Err((reason, seen)) = check_request_host(&req, target) {
        if target.tls {
            ctx.alert(AlertKind::DomainFronting, &target.host, None, format!("routed to {} but request names {}", target.host, clip(&seen, 256)));
            ctx.audit(mk_audit(&req, EgressVerdict::Alert).reason(if reason == "host_mismatch" { "host_sni_mismatch" } else { reason }));
        } else {
            ctx.audit(mk_audit(&req, EgressVerdict::Deny).reason(reason));
        }
        return deny_response(StatusCode::FORBIDDEN, "host_mismatch", &target.host, target.port, "the request target and Host header must name the host this connection is for, exactly once");
    }

    // Credential injection (or blocking).
    let view = ctx.view();
    let Some(policy) = view.policy.clone() else {
        return deny_response(StatusCode::FORBIDDEN, "egress_denied", &target.host, target.port, "no policy");
    };
    let uri = req.uri().clone();
    let verdict = inject::apply(
        &inject::Input {
            bindings: &policy.inject,
            secrets: &view.secrets,
            host: &target.host,
            tls: target.tls,
            live: ctx.live(),
            now_ms: now_ms(),
        },
        req.headers_mut(),
        &uri,
    );
    match &verdict {
        Verdict::WrongHost(b) => {
            ctx.alert(AlertKind::PlaceholderWrongHost, &target.host, Some(b.as_str()), format!("placeholder for binding {b} sent to {}", target.host));
            ctx.audit(mk_audit(&req, EgressVerdict::Alert).reason("placeholder_wrong_host").binding(b));
            return deny_response(StatusCode::FORBIDDEN, "credential_blocked", &target.host, target.port, "a credential placeholder was sent to a host outside its binding");
        }
        Verdict::Expired(b) => {
            ctx.alert(AlertKind::InjectionAfterExpiry, &target.host, Some(b.as_str()), format!("binding {b}: no valid secret (expired, fenced or missing)"));
            ctx.audit(mk_audit(&req, EgressVerdict::Alert).reason("injection_unavailable").binding(b));
            return deny_response(StatusCode::FORBIDDEN, "credential_unavailable", &target.host, target.port, "the credential for this host is not available right now");
        }
        Verdict::Plaintext(b) => {
            ctx.audit(mk_audit(&req, EgressVerdict::Deny).reason("injection_requires_tls").binding(b));
            return deny_response(StatusCode::FORBIDDEN, "credential_requires_tls", &target.host, target.port, "credentials are only injected over HTTPS");
        }
        Verdict::Clean | Verdict::Substituted(_) => {}
    }
    // Request guards (docs/sandbox/networking/egress/policy/#request-guards): generic rules, after
    // injection (a guard can ask whether a binding was substituted) and before anything goes upstream.
    // Only a host some guard names is decided, within bounds: its target is decoded once, and one past
    // them is refused rather than decided (deciding costs time in its length per matcher).
    if policy.guards.iter().any(|g| guard::covers(g, &target.host)) {
        let (method, path, query) = (req.method().as_str().to_owned(), uri.path().to_owned(), uri.query().map(str::to_owned));
        let greq = guard::Req { host: &target.host, method: &method, path: &path, query: query.as_deref(), injected: match &verdict {
            Verdict::Substituted(b) => Some(b.as_str()),
            _ => None,
        } };
        let Ok(greq) = greq.prepare() else {
            let mut a = mk_audit(&req, EgressVerdict::Deny).reason("guard_target_too_long");
            a.binding = verdict.binding().map(str::to_string);
            ctx.audit(a);
            return deny_response(
                StatusCode::URI_TOO_LONG,
                "request_target_too_long",
                &target.host,
                target.port,
                "this host's requests are checked by request guards, which decide paths of at most 4096 bytes and 256 segments and queries of at most 8192 bytes and 256 parameters",
            );
        };
        let json: Option<serde_json::Value>;
        let body_view = if guard::needs_body(&policy.guards, &greq) {
            let (parts, body) = req.into_parts();
            let Ok((read, replay)) = read_guard_body(&parts.headers, body).await else {
                return simple(StatusCode::BAD_REQUEST, "the request body could not be read");
            };
            req = Request::from_parts(parts, replay);
            json = read;
            json.as_ref().map_or(guard::BodyView::Unknown, guard::BodyView::Json)
        } else {
            guard::BodyView::Unread
        };
        if let Some(g) = guard::refusing(&policy.guards, &greq, &body_view) {
            let mut a = mk_audit(&req, EgressVerdict::Deny).reason(format!("guard: {}", clip(&g.name, 64)));
            a.binding = verdict.binding().map(str::to_string);
            ctx.audit(a);
            let reason = if g.reason.is_empty() { "a request guard in this sandbox's egress policy refuses this request" } else { g.reason.as_str() };
            let mut v = deny_json("request_denied", &target.host, target.port, &clip(reason, 512));
            v["guard"] = serde_json::Value::String(clip(&g.name, 64));
            return json_response(StatusCode::FORBIDDEN, v);
        }
    }
    // Secrets the upstream might echo back (TRACE, header-reflecting endpoints, error pages).
    let mut needles: Vec<Vec<u8>> = Vec::new();
    if let Verdict::Substituted(b) = &verdict {
        if req.method() == Method::TRACE || req.method().as_str() == "TRACK" {
            ctx.audit(mk_audit(&req, EgressVerdict::Deny).reason("trace_with_credential").binding(b));
            return deny_response(StatusCode::METHOD_NOT_ALLOWED, "method_blocked", &target.host, target.port, "TRACE is not allowed on requests carrying an injected credential");
        }
        needles = scrub_needles(req.headers(), view.secrets.get(b).map(|s| s.value.as_str()));
    }
    let mut audit = mk_audit(&req, EgressVerdict::Allow);
    audit.binding = verdict.binding().map(str::to_string);

    // Upgrades (WebSocket etc., HTTP/1.1 only).
    let upgrading = !up.h2 && req.headers().contains_key(UPGRADE);
    let client_upgrade = upgrading.then(|| hyper::upgrade::on(&mut req));

    let (mut parts, body) = req.into_parts();
    // gRPC over h2 requires `te: trailers` (the only TE value h2 permits); keep exactly that.
    let te_trailers = up.h2
        && parts.headers.get_all(TE).iter().any(|v| v.to_str().is_ok_and(|s| s.split(',').any(|t| t.trim().eq_ignore_ascii_case("trailers"))));
    strip_hop_by_hop(&mut parts.headers, upgrading);
    if te_trailers {
        parts.headers.insert(TE, http::HeaderValue::from_static("trailers"));
    }
    parts.uri = upstream_uri(&parts.uri, target, up.h2);
    if !up.h2 {
        // Always our own Host (replacing whatever the client sent) for h1 upstreams.
        let host = if default_port(target) { target.host.clone() } else { format!("{}:{}", target.host, target.port) };
        match host.parse() {
            Ok(v) => {
                parts.headers.insert(HOST, v);
            }
            Err(_) => return deny_response(StatusCode::BAD_REQUEST, "invalid_host", &target.host, target.port, "invalid host"),
        }
    }
    if up.h2 {
        parts.version = http::Version::HTTP_2;
        parts.headers.remove(HOST);
    } else {
        parts.version = http::Version::HTTP_11;
    }
    let up_bytes = Arc::new(AtomicU64::new(0));
    let limit = policy.limits.max_inspected_body_bytes.min(usize::MAX as u64) as usize;
    let body: Body = Counted { inner: Limited::new(body, limit), n: up_bytes.clone() }.boxed();
    let out = Request::from_parts(parts, body);

    let mut resp = match up.send(out).await {
        Ok(r) => r,
        Err(e) => {
            audit.bytes_up = up_bytes.load(Ordering::Relaxed);
            audit.reason = Some(format!("upstream: {e}"));
            audit.status = Some(502);
            ctx.audit(audit);
            return json_response(StatusCode::BAD_GATEWAY, serde_json::json!({"error": "upstream_error", "host": target.host}));
        }
    };
    audit.status = Some(resp.status().as_u16());

    if let Some(client_upgrade) = client_upgrade
        && resp.status() == StatusCode::SWITCHING_PROTOCOLS
    {
        let up_upgrade = hyper::upgrade::on(&mut resp);
        let ctx2 = ctx.clone();
        let (host, port) = (target.host.clone(), target.port);
        tokio::spawn(async move {
            let (Ok(c), Ok(u)) = tokio::join!(client_upgrade, up_upgrade) else { return };
            let mut c = TokioIo::new(c);
            let mut u = TokioIo::new(u);
            let drop = ctx2.sandbox.drop.clone();
            let r = tokio::select! { _ = drop.cancelled() => Ok((0, 0)), r = tokio::io::copy_bidirectional(&mut c, &mut u) => r };
            let (a, b) = r.unwrap_or((0, 0));
            let mut au = Audit::new(&host, port, EgressVerdict::Allow).reason("upgraded");
            au.bytes_up = a;
            au.bytes_down = b;
            au.status = Some(101);
            ctx2.audit(au);
        });
        let (mut p, _) = resp.into_parts();
        p.headers.remove("transfer-encoding");
        return Response::from_parts(p, empty());
    }

    let (mut p, body) = resp.into_parts();
    strip_hop_by_hop(&mut p.headers, false);
    let body: Body = AuditOnEnd { inner: body, down: 0, up: up_bytes, pending: Some((ctx, audit)) }
        .map_err(|e| Box::new(e) as BoxError)
        .boxed();
    if needles.is_empty() {
        return Response::from_parts(p, body);
    }
    scrub_headers(&mut p.headers, &needles);
    // Compressed bodies can't be scanned without decoding; they pass through (headers are still
    // scrubbed). Identity bodies are masked in a streaming, length-preserving way.
    let encoded = p.headers.get(http::header::CONTENT_ENCODING).is_some_and(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"));
    if encoded {
        return Response::from_parts(p, body);
    }
    Response::from_parts(p, ScrubBody::new(body, needles).boxed())
}

/// The routed host must be the only name in the request: the request-target authority (if
/// any) and the single `Host` header (if any) must both normalize to `target.host`.
fn check_request_host<B>(req: &Request<B>, target: &Target) -> Result<(), (&'static str, String)> {
    let hosts: Vec<&http::HeaderValue> = req.headers().get_all(HOST).iter().collect();
    if hosts.len() > 1 {
        return Err(("duplicate_host", format!("{} Host headers", hosts.len())));
    }
    let mut names: Vec<String> = Vec::new();
    if let Some(a) = req.uri().authority() {
        names.push(a.as_str().to_string());
    }
    for h in hosts {
        match h.to_str() {
            Ok(s) => names.push(s.to_string()),
            Err(_) => return Err(("invalid_host", "non-ASCII Host header".into())),
        }
    }
    match names.into_iter().find(|n| norm_host(n) != target.host) {
        Some(n) => Err(("host_mismatch", n)),
        None => Ok(()),
    }
}

/// Byte strings to mask in responses: the raw secret plus the exact credential header values we
/// injected (and the base64 part of `Basic` ones, which doesn't contain the raw secret).
fn scrub_needles(headers: &HeaderMap, secret: Option<&str>) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        out.push(s.as_bytes().to_vec());
    }
    for v in headers.values().filter(|v| v.is_sensitive()) {
        out.push(v.as_bytes().to_vec());
        if let Ok(s) = v.to_str()
            && let Some((scheme, rest)) = s.split_once(' ')
            && scheme.eq_ignore_ascii_case("basic")
        {
            out.push(rest.trim().as_bytes().to_vec());
        }
    }
    // Longest first so a full header value is masked whole before its parts.
    out.sort_by_key(|n| std::cmp::Reverse(n.len()));
    out.dedup();
    out
}

fn scrub_headers(h: &mut HeaderMap, needles: &[Vec<u8>]) {
    for v in h.values_mut() {
        let mut b = v.as_bytes().to_vec();
        if mask_all(&mut b, needles)
            && let Ok(nv) = http::HeaderValue::from_bytes(&b)
        {
            *v = nv;
        }
    }
}

/// Streaming, length-preserving mask of secret bytes in a response body. Keeps a tail of
/// `longest needle - 1` bytes between frames so a secret split across frames is still caught.
struct ScrubBody {
    inner: Body,
    needles: Vec<Vec<u8>>,
    keep: usize,
    pending: Vec<u8>,
    held: Option<Frame<Bytes>>,
    done: bool,
}

impl ScrubBody {
    fn new(inner: Body, needles: Vec<Vec<u8>>) -> Self {
        let keep = needles.iter().map(Vec::len).max().unwrap_or(1).saturating_sub(1);
        ScrubBody { inner, needles, keep, pending: Vec::new(), held: None, done: false }
    }

    fn take(&mut self, all: bool) -> Option<Bytes> {
        mask_all(&mut self.pending, &self.needles);
        let n = if all { self.pending.len() } else { self.pending.len().saturating_sub(self.keep) };
        (n > 0).then(|| Bytes::from(self.pending.drain(..n).collect::<Vec<u8>>()))
    }
}

impl HttpBody for ScrubBody {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        loop {
            if let Some(f) = self.held.take() {
                return Poll::Ready(Some(Ok(f)));
            }
            if self.done {
                return Poll::Ready(self.take(true).map(|b| Ok(Frame::data(b))));
            }
            match Pin::new(&mut self.inner).poll_frame(cx) {
                Poll::Ready(Some(Ok(f))) => match f.into_data() {
                    Ok(d) => {
                        self.pending.extend_from_slice(&d);
                        if let Some(b) = self.take(false) {
                            return Poll::Ready(Some(Ok(Frame::data(b))));
                        }
                    }
                    Err(trailers) => {
                        // Flush buffered data before the trailers.
                        match self.take(true) {
                            Some(b) => {
                                self.held = Some(trailers);
                                return Poll::Ready(Some(Ok(Frame::data(b))));
                            }
                            None => return Poll::Ready(Some(Ok(trailers))),
                        }
                    }
                },
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Some(Err(e))),
                Poll::Ready(None) => self.done = true,
                Poll::Pending => return Poll::Pending,
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done && self.pending.is_empty() && self.held.is_none()
    }
}

fn default_port(t: &Target) -> bool {
    (t.tls && t.port == 443) || (!t.tls && t.port == 80)
}

fn upstream_uri(uri: &Uri, target: &Target, h2: bool) -> Uri {
    let pq = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    if h2 {
        let scheme = if target.tls { "https" } else { "http" };
        let auth = if default_port(target) { target.host.clone() } else { format!("{}:{}", target.host, target.port) };
        format!("{scheme}://{auth}{pq}").parse().unwrap_or_else(|_| Uri::from_static("/"))
    } else {
        pq.parse().unwrap_or_else(|_| Uri::from_static("/"))
    }
}

fn strip_hop_by_hop(h: &mut HeaderMap, keep_upgrade: bool) {
    // Also drop headers named in Connection.
    let named: Vec<String> = h
        .get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(',').map(|s| s.trim().to_ascii_lowercase()))
        .filter(|n| !(keep_upgrade && n == "upgrade"))
        .collect();
    for n in named {
        h.remove(n.as_str());
    }
    for n in HOP_BY_HOP {
        if keep_upgrade && (*n == "upgrade" || *n == "connection") {
            continue;
        }
        h.remove(*n);
    }
    if keep_upgrade {
        h.insert(CONNECTION, http::HeaderValue::from_static("upgrade"));
    }
}

// ---------------------------------------------------------------------------------------------
// Upstream connections
// ---------------------------------------------------------------------------------------------

enum Sender {
    H1(hyper::client::conn::http1::SendRequest<Body>),
    H2(hyper::client::conn::http2::SendRequest<Body>),
}

impl Sender {
    fn is_closed(&self) -> bool {
        match self {
            Sender::H1(s) => s.is_closed(),
            Sender::H2(s) => s.is_closed(),
        }
    }
}

/// One logical upstream for a client connection; reconnects if the upstream closes.
pub struct UpstreamConn {
    ctx: Arc<ConnCtx>,
    target: Arc<Target>,
    h2: bool,
    sender: tokio::sync::Mutex<Option<Sender>>,
}

impl UpstreamConn {
    fn lazy(ctx: Arc<ConnCtx>, target: Arc<Target>, h2: bool) -> Self {
        UpstreamConn { ctx, target, h2, sender: tokio::sync::Mutex::new(None) }
    }

    async fn from_tls(
        ctx: Arc<ConnCtx>,
        target: Arc<Target>,
        io: tokio_rustls::client::TlsStream<TcpStream>,
        h2: bool,
    ) -> io::Result<Self> {
        let sender = handshake(&ctx, io, h2).await?;
        Ok(UpstreamConn { ctx, target, h2, sender: tokio::sync::Mutex::new(Some(sender)) })
    }

    async fn connect(&self) -> io::Result<Sender> {
        let t = &self.target;
        if t.tls {
            let alpn = if self.h2 { vec![b"h2".to_vec()] } else { vec![b"http/1.1".to_vec()] };
            let io = connect_tls(&self.ctx, &t.host, t.port, &alpn).await?;
            let got_h2 = io.get_ref().1.alpn_protocol() == Some(b"h2");
            if got_h2 != self.h2 {
                return Err(io::Error::other("upstream changed protocol on reconnect"));
            }
            handshake(&self.ctx, io, self.h2).await
        } else {
            let io = connect_host(&self.ctx, &t.host, t.port).await?;
            handshake(&self.ctx, io, false).await
        }
    }

    async fn send(&self, req: Request<Body>) -> io::Result<Response<Incoming>> {
        // h1 is serial: hold the lock until the request is dispatched. h2 multiplexes: clone the
        // sender and release the lock before awaiting the response.
        let mut g = self.sender.lock().await;
        if g.as_ref().is_none_or(Sender::is_closed) {
            *g = Some(self.connect().await?);
        }
        match g.as_mut().unwrap() {
            Sender::H1(s) => {
                s.ready().await.map_err(io::Error::other)?;
                let fut = s.send_request(req);
                drop(g);
                fut.await.map_err(io::Error::other)
            }
            Sender::H2(s) => {
                let mut s = s.clone();
                drop(g);
                s.ready().await.map_err(io::Error::other)?;
                s.send_request(req).await.map_err(io::Error::other)
            }
        }
    }
}

async fn handshake<T>(ctx: &ConnCtx, io: T, h2: bool) -> io::Result<Sender>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let drop = ctx.sandbox.drop.clone();
    if h2 {
        let (s, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .timer(TokioTimer::new())
            .handshake(TokioIo::new(io))
            .await
            .map_err(io::Error::other)?;
        tokio::spawn(async move { tokio::select! { _ = drop.cancelled() => {}, _ = conn => {} } });
        Ok(Sender::H2(s))
    } else {
        let (s, conn) = hyper::client::conn::http1::handshake(TokioIo::new(io)).await.map_err(io::Error::other)?;
        tokio::spawn(async move { tokio::select! { _ = drop.cancelled() => {}, _ = conn.with_upgrades() => {} } });
        Ok(Sender::H1(s))
    }
}

async fn connect_tls(
    ctx: &ConnCtx,
    host: &str,
    port: u16,
    alpn: &[Vec<u8>],
) -> io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
    let tcp = connect_host(ctx, host, port).await?;
    let cfg = ctx.session.upstream.tls.client_config(alpn).map_err(io::Error::other)?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    tokio::time::timeout(CONNECT_TIMEOUT, TlsConnector::from(cfg).connect(name, tcp))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "upstream TLS timeout"))?
}

/// Resolve `host` ourselves (never trusting the IP a guest dialed) and connect.
pub async fn connect_host(ctx: &ConnCtx, host: &str, port: u16) -> io::Result<TcpStream> {
    if !ctx.live() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "egress paused (lease or sandbox dropped)"));
    }
    let addrs = ctx.session.upstream.resolve(host, port).await?;
    connect_addrs(ctx, &addrs).await
}

async fn connect_addrs(ctx: &ConnCtx, addrs: &[SocketAddr]) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no addresses");
    for a in addrs {
        if !ctx.session.upstream.allow_private && !is_public(a.ip()) {
            last = io::Error::new(io::ErrorKind::PermissionDenied, format!("non-public upstream address {}", a.ip()));
            continue;
        }
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(e)) => last = e,
            Err(_) => last = io::Error::new(io::ErrorKind::TimedOut, format!("connect {a} timed out")),
        }
    }
    Err(last)
}

/// Upstreams must be public addresses: never loopback, link-local (IMDS), private, CGNAT,
/// unique-local, multicast or unspecified. Policy names that resolve there are refused.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_multicast()
                || v.is_broadcast()
                || v.is_unspecified()
                || v.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // IETF protocol assignments 192.0.0.0/24
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v.segments();
            let o = v.octets();
            let embedded = |i: usize| IpAddr::V4(std::net::Ipv4Addr::new(o[i], o[i + 1], o[i + 2], o[i + 3]));
            // NAT64 well-known prefix 64:ff9b::/96: judge the embedded IPv4 (a NAT64 gateway would
            // forward it into the VPC otherwise).
            if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return is_public(embedded(12));
            }
            // 6to4 2002::/16 embeds an IPv4 in bits 16..48.
            if s[0] == 0x2002 {
                return is_public(embedded(2));
            }
            // Deprecated IPv4-compatible ::a.b.c.d (first 96 bits zero; :: and ::1 are below).
            if s[..6] == [0; 6] && !v.is_unspecified() && !v.is_loopback() {
                return is_public(embedded(12));
            }
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10 (deprecated)
                || (s[0] == 0x64 && s[1] == 0xff9b && s[2] == 1) // local-use NAT64 64:ff9b:1::/48
                || (s[0] == 0x2001 && s[1] == 0) // Teredo 2001::/32 (tunnels to embedded IPv4)
                || (s[0] == 0x2001 && s[1] == 0xdb8) // documentation
                || (s[0] == 0x100 && s[1] == 0 && s[2] == 0 && s[3] == 0)) // discard-only 100::/64
        }
    }
}

/// Bidirectional copy until either side closes or the sandbox is dropped; audited at the end.
async fn splice<A, B>(ctx: &ConnCtx, mut a: A, mut b: B, host: &str, port: u16, verdict: EgressVerdict, reason: Option<&str>)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let drop = ctx.sandbox.drop.clone();
    let r = tokio::select! {
        _ = drop.cancelled() => Ok((0, 0)),
        r = tokio::io::copy_bidirectional(&mut a, &mut b) => r,
    };
    let (up, down) = r.unwrap_or((0, 0));
    let mut au = Audit::new(host, port, verdict);
    au.bytes_up = up;
    au.bytes_down = down;
    au.reason = reason.map(str::to_string);
    ctx.audit(au);
}

// ---------------------------------------------------------------------------------------------
// Bodies and responses
// ---------------------------------------------------------------------------------------------

fn empty() -> Body {
    Full::new(Bytes::new()).map_err(|e| match e {}).boxed()
}

fn json_response(status: StatusCode, v: serde_json::Value) -> Response<Body> {
    let body = Full::new(Bytes::from(v.to_string())).map_err(|e| match e {}).boxed();
    let mut r = Response::new(body);
    *r.status_mut() = status;
    r.headers_mut().insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("application/json"));
    r.headers_mut().insert("x-nest-proxy", http::HeaderValue::from_static("1"));
    r
}

fn simple(status: StatusCode, msg: &str) -> Response<Body> {
    json_response(status, serde_json::json!({"error": "bad_request", "reason": msg}))
}

/// The readable denial agents see: what was blocked and how to ask for access.
pub fn deny_response(status: StatusCode, code: &str, host: &str, port: u16, reason: &str) -> Response<Body> {
    json_response(status, deny_json(code, host, port, reason))
}

fn deny_json(code: &str, host: &str, port: u16, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "error": code,
        "host": clip(host, 256),
        "port": port,
        "reason": reason,
        "hint": "nest-proxy blocked this request. Ask for access with the `egress_policy` tool (`allow: [{host}]`) if you have it (from a tainted session the operator approves it first); otherwise tell your owner.",
    })
}

/// A request body a guard may read: at most this much is buffered.
const GUARD_BODY_MAX: usize = 64 * 1024;

/// Read up to [`GUARD_BODY_MAX`] of a request body for a guard: its JSON (`None` when it is encoded,
/// larger than that, slower than the header timeout, or not JSON), and a body that replays what was
/// read and then the rest. `Err` when the client's body fails.
async fn read_guard_body(headers: &HeaderMap, mut body: Body) -> Result<(Option<serde_json::Value>, Body), ()> {
    let encoded = headers.get(http::header::CONTENT_ENCODING).is_some_and(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"));
    if encoded {
        return Ok((None, body));
    }
    let mut frames: std::collections::VecDeque<Frame<Bytes>> = std::collections::VecDeque::new();
    let mut data: Vec<u8> = Vec::new();
    let read = tokio::time::timeout(HEADER_TIMEOUT, async {
        while data.len() <= GUARD_BODY_MAX {
            match body.frame().await {
                None => return Ok(true),
                Some(Err(_)) => return Err(()),
                Some(Ok(f)) => {
                    if let Some(d) = f.data_ref() {
                        data.extend_from_slice(d);
                    }
                    frames.push_back(f);
                }
            }
        }
        Ok(false)
    })
    .await;
    let complete = match read {
        Ok(r) => r?,
        Err(_) => false,
    };
    let json = if complete && data.len() <= GUARD_BODY_MAX { serde_json::from_slice(&data).ok() } else { None };
    let queued = data.len() as u64;
    let rest = if complete { None } else { Some(body) };
    Ok((json, Replay { frames, queued, rest }.boxed()))
}

/// Frames already read, then the rest of the body.
struct Replay {
    frames: std::collections::VecDeque<Frame<Bytes>>,
    queued: u64,
    rest: Option<Body>,
}

impl HttpBody for Replay {
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        if let Some(f) = self.frames.pop_front() {
            if let Some(d) = f.data_ref() {
                self.queued -= d.len() as u64;
            }
            return Poll::Ready(Some(Ok(f)));
        }
        match self.rest.as_mut() {
            Some(r) => Pin::new(r).poll_frame(cx),
            None => Poll::Ready(None),
        }
    }
    fn is_end_stream(&self) -> bool {
        self.frames.is_empty() && self.rest.as_ref().is_none_or(|r| r.is_end_stream())
    }
    fn size_hint(&self) -> SizeHint {
        let rest = self.rest.as_ref().map_or_else(|| SizeHint::with_exact(0), |r| r.size_hint());
        let mut h = SizeHint::new();
        h.set_lower(rest.lower() + self.queued);
        if let Some(u) = rest.upper() {
            h.set_upper(u + self.queued);
        }
        h
    }
}

/// Counts bytes passing through a body.
struct Counted<B> {
    inner: B,
    n: Arc<AtomicU64>,
}

impl<B> HttpBody for Counted<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
    B::Error: Into<BoxError>,
{
    type Data = Bytes;
    type Error = BoxError;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        match Pin::new(&mut self.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(f))) => {
                if let Some(d) = f.data_ref() {
                    self.n.fetch_add(d.len() as u64, Ordering::Relaxed);
                }
                Poll::Ready(Some(Ok(f)))
            }
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e.into()))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Response body that emits the request's audit record when it ends (or is dropped).
struct AuditOnEnd {
    inner: Incoming,
    down: u64,
    up: Arc<AtomicU64>,
    pending: Option<(Arc<ConnCtx>, Audit)>,
}

impl AuditOnEnd {
    fn finish(&mut self) {
        if let Some((ctx, mut a)) = self.pending.take() {
            a.bytes_down = self.down;
            a.bytes_up = self.up.load(Ordering::Relaxed);
            ctx.audit(a);
        }
    }
}

impl HttpBody for AuditOnEnd {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let r = Pin::new(&mut self.inner).poll_frame(cx);
        match &r {
            Poll::Ready(Some(Ok(f))) => {
                if let Some(d) = f.data_ref() {
                    self.down += d.len() as u64;
                }
            }
            Poll::Ready(None) | Poll::Ready(Some(Err(_))) => self.finish(),
            Poll::Pending => {}
        }
        r
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for AuditOnEnd {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_address_filter() {
        for ip in [
            "127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fe80::1",
            "fd00::1", "::ffff:10.0.0.1", "0.0.0.0", "192.0.0.170",
            // NAT64 / 6to4 / IPv4-compatible forms embedding private or link-local IPv4.
            "64:ff9b::a9fe:a9fe", "64:ff9b::10.0.0.1", "64:ff9b:1::8.8.8.8", "2002:a9fe:a9fe::1", "2002:0a00:0001::",
            "::10.0.0.1", "::169.254.169.254", "fec0::1", "2001:0:4136:e378::1", "100::1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["140.82.112.3", "2606:4700::1111", "8.8.8.8", "64:ff9b::8.8.8.8", "2002:0808:0808::1"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn hop_by_hop_stripping() {
        let mut h = HeaderMap::new();
        h.insert(CONNECTION, "keep-alive, x-secret-hop".parse().unwrap());
        h.insert("x-secret-hop", "1".parse().unwrap());
        h.insert("proxy-authorization", "Basic abc".parse().unwrap());
        h.insert("keep-alive", "timeout=5".parse().unwrap());
        h.insert("accept", "*/*".parse().unwrap());
        strip_hop_by_hop(&mut h, false);
        assert_eq!(h.len(), 1);
        let mut h = HeaderMap::new();
        h.insert(CONNECTION, "Upgrade".parse().unwrap());
        h.insert(UPGRADE, "websocket".parse().unwrap());
        strip_hop_by_hop(&mut h, true);
        assert_eq!(h[UPGRADE], "websocket");
        assert_eq!(h[CONNECTION], "upgrade");
    }

    #[test]
    fn scrub_needles_cover_bearer_and_basic() {
        use base64::Engine;
        let mut h = HeaderMap::new();
        let basic = base64::engine::general_purpose::STANDARD.encode("x-access-token:ghs_REAL");
        let mut v = http::HeaderValue::from_str(&format!("Basic {basic}")).unwrap();
        v.set_sensitive(true);
        h.insert(http::header::AUTHORIZATION, v);
        let n = scrub_needles(&h, Some("ghs_REAL"));
        assert!(n.iter().any(|x| x == basic.as_bytes()));
        assert!(n.iter().any(|x| x == b"ghs_REAL"));
        let mut body = format!("echo: Basic {basic} and ghs_REAL").into_bytes();
        mask_all(&mut body, &n);
        let s = String::from_utf8(body).unwrap();
        assert!(!s.contains("ghs_REAL") && !s.contains(&basic), "{s}");
    }

    /// A body yielding fixed frames (test only).
    struct Frames(std::collections::VecDeque<Frame<Bytes>>);

    impl HttpBody for Frames {
        type Data = Bytes;
        type Error = BoxError;
        fn poll_frame(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
            Poll::Ready(self.0.pop_front().map(Ok))
        }
    }

    #[tokio::test]
    async fn scrub_body_catches_secrets_split_across_frames() {
        let mut frames: std::collections::VecDeque<Frame<Bytes>> =
            ["abc gh", "s_RE", "AL xyz ghs_REAL", " end"].into_iter().map(|c| Frame::data(Bytes::from_static(c.as_bytes()))).collect();
        let mut trailers = HeaderMap::new();
        trailers.insert("grpc-status", "0".parse().unwrap());
        frames.push_back(Frame::trailers(trailers));
        let inner: Body = Frames(frames).boxed();
        let collected = ScrubBody::new(inner, vec![b"ghs_REAL".to_vec()]).collect().await.unwrap();
        assert_eq!(collected.trailers().unwrap()["grpc-status"], "0");
        assert_eq!(&collected.to_bytes()[..], b"abc ******** xyz ******** end");
    }

    #[test]
    fn uri_forms() {
        let t = Target { host: "api.github.com".into(), port: 443, tls: true };
        let u: Uri = "/repos?x=1".parse().unwrap();
        assert_eq!(upstream_uri(&u, &t, false), "/repos?x=1");
        assert_eq!(upstream_uri(&u, &t, true), "https://api.github.com/repos?x=1");
        let t = Target { host: "x.test".into(), port: 8080, tls: false };
        let u: Uri = "http://x.test:8080/a".parse().unwrap();
        assert_eq!(upstream_uri(&u, &t, false), "/a");
    }
}
