//! Audit records: one per proxied request (inspected) or connection (deny/passthrough/tcp),
//! batched to nestd every ≤1 s or 128 records. Never contains secret values or query strings.

use std::time::Duration;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use nest_protocol::control::{EgressAuditKind, EgressAuditRecord, EgressReason, EgressVerdict, EgressVia};
use nest_protocol::host::proxy::ListenerPurpose;
use nest_protocol::host::fdpass::MAX_PACKET_FROM_PROXY;
use nest_protocol::host::proxy::ProxyEvent;
use nest_protocol::model::{AgentId, Epoch, SandboxId};

use crate::util::{clip, clip_in_place, now_ms};

pub const BATCH_MAX: usize = 128;

/// Caps on guest-influenced strings in events to nestd (keeps every packet far below
/// `MAX_PACKET_FROM_PROXY`).
pub const MAX_HOST: usize = 256;
pub const MAX_PATH: usize = 1024;
pub const MAX_SHORT: usize = 128;
pub const MAX_DETAIL: usize = 1024;
pub const FLUSH_EVERY: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
pub struct Audit {
    pub host: String,
    pub port: u16,
    pub method: Option<String>,
    pub path: Option<String>,
    pub status: Option<u16>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub verdict: EgressVerdict,
    pub binding: Option<String>,
    pub reason: Option<EgressReason>,
    /// Aggregated records: how many requests this record stands for.
    pub count: Option<u32>,
    pub kind: EgressAuditKind,
}

impl Audit {
    pub fn new(host: &str, port: u16, verdict: EgressVerdict) -> Self {
        Audit {
            host: host.to_string(),
            port,
            method: None,
            path: None,
            status: None,
            bytes_up: 0,
            bytes_down: 0,
            verdict,
            binding: None,
            reason: None,
            kind: EgressAuditKind::Request,
            count: None,
        }
    }

    pub fn reason(mut self, r: EgressReason) -> Self {
        self.reason = Some(r);
        self
    }

    pub fn request(mut self, method: &http::Method, uri: &http::Uri) -> Self {
        self.method = Some(method.as_str().to_string());
        self.path = Some(path_only(uri));
        self
    }

    pub fn into_record(self, sandbox: &SandboxId, epoch: Epoch, agent: Option<AgentId>, via: Option<EgressVia>) -> EgressAuditRecord {
        EgressAuditRecord {
            sandbox: sandbox.clone(),
            epoch,
            agent,
            ts_ms: now_ms(),
            via,
            host: clip(&self.host, MAX_HOST),
            port: self.port,
            method: self.method.map(|m| clip(&m, MAX_SHORT)),
            path: self.path.map(|p| clip(&p, MAX_PATH)),
            status: self.status,
            bytes_up: self.bytes_up,
            bytes_down: self.bytes_down,
            verdict: self.verdict,
            binding: self.binding.map(|b| clip(&b, MAX_SHORT)),
            reason: self.reason.map(clip_reason),
            count: self.count,
            kind: self.kind,
        }
    }
}

/// The audit `via` for a listener purpose.
pub fn via(purpose: &ListenerPurpose) -> EgressVia {
    match purpose {
        ListenerPurpose::Dns => EgressVia::Dns,
        ListenerPurpose::HttpTransparent => EgressVia::HttpTransparent,
        ListenerPurpose::HttpsTransparent => EgressVia::HttpsTransparent,
        ListenerPurpose::Explicit { .. } => EgressVia::Explicit,
        ListenerPurpose::TcpException { .. } => EgressVia::TcpException,
    }
}

/// Cap the free text a reason may carry (an upstream error can echo guest-chosen names).
pub fn clip_reason(r: EgressReason) -> EgressReason {
    match r {
        EgressReason::Upstream { stage, mut detail } => {
            clip_in_place(&mut detail, MAX_DETAIL);
            EgressReason::Upstream { stage, detail }
        }
        EgressReason::Other(mut s) => {
            clip_in_place(&mut s, MAX_DETAIL);
            EgressReason::Other(s)
        }
        unit => unit,
    }
}

/// Path without query string or fragment (query strings may carry secrets).
pub fn path_only(uri: &http::Uri) -> String {
    let p = uri.path();
    if p.is_empty() { "/".to_string() } else { p.to_string() }
}

/// Clip every guest-influenced string in an outgoing event (defense in depth; records are
/// already clipped when built).
pub fn clip_event(mut ev: ProxyEvent) -> ProxyEvent {
    match &mut ev {
        ProxyEvent::Audit { records } => {
            for r in records {
                clip_in_place(&mut r.host, MAX_HOST);
                if let Some(p) = &mut r.path {
                    clip_in_place(p, MAX_PATH);
                }
                if let Some(m) = &mut r.method {
                    clip_in_place(m, MAX_SHORT);
                }
                if let Some(b) = &mut r.binding {
                    clip_in_place(b, MAX_SHORT);
                }
                if let Some(x) = r.reason.take() {
                    r.reason = Some(clip_reason(x));
                }
            }
        }
        ProxyEvent::Alert { host, binding, detail, .. } => {
            clip_in_place(host, MAX_HOST);
            if let Some(b) = binding {
                clip_in_place(b, MAX_SHORT);
            }
            clip_in_place(detail, MAX_DETAIL);
        }
        ProxyEvent::ListenerFailed { error, .. } | ProxyEvent::Error { error } => {
            clip_in_place(&mut error.message, MAX_DETAIL);
            clip_in_place(&mut error.code, MAX_SHORT);
        }
        ProxyEvent::Hello { proxy_version, .. } => clip_in_place(proxy_version, MAX_SHORT),
        ProxyEvent::ResyncAck { .. } | ProxyEvent::Pong { .. } => {}
    }
    ev
}

/// Collects records and emits `ProxyEvent::Audit` batches that fit one SEQPACKET.
pub async fn batcher(
    mut rx: mpsc::Receiver<EgressAuditRecord>,
    events: mpsc::UnboundedSender<ProxyEvent>,
    cancel: CancellationToken,
) {
    let mut buf: Vec<EgressAuditRecord> = Vec::new();
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            r = rx.recv() => match r {
                Some(rec) => {
                    buf.push(rec);
                    if buf.len() >= BATCH_MAX {
                        flush(&mut buf, &events);
                    }
                }
                None => break,
            },
            _ = tick.tick() => flush(&mut buf, &events),
        }
    }
    flush(&mut buf, &events);
}

fn flush(buf: &mut Vec<EgressAuditRecord>, events: &mpsc::UnboundedSender<ProxyEvent>) {
    if buf.is_empty() {
        return;
    }
    for batch in split_to_fit(std::mem::take(buf)) {
        let _ = events.send(ProxyEvent::Audit { records: batch });
    }
}

/// Split records into batches whose serialized event fits the packet limit (with headroom).
fn split_to_fit(records: Vec<EgressAuditRecord>) -> Vec<Vec<EgressAuditRecord>> {
    let limit = MAX_PACKET_FROM_PROXY - 1024;
    let mut out = Vec::new();
    let mut cur = Vec::new();
    let mut size = 32;
    for r in records {
        let n = serde_json::to_vec(&r).map(|v| v.len() + 1).unwrap_or(limit);
        if !cur.is_empty() && size + n > limit {
            out.push(std::mem::take(&mut cur));
            size = 32;
        }
        if n > limit {
            continue; // pathological single record; drop rather than break the channel
        }
        size += n;
        cur.push(r);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(path_len: usize) -> EgressAuditRecord {
        let mut a = Audit::new("github.com", 443, EgressVerdict::Allow);
        a.path = Some("/".repeat(path_len));
        a.into_record(&SandboxId("sbx_1".into()), Epoch(1), None, None)
    }

    #[test]
    fn batches_fit_packet() {
        let recs: Vec<_> = (0..200).map(|_| rec(2000)).collect();
        let batches = split_to_fit(recs);
        assert!(batches.len() > 1);
        assert_eq!(batches.iter().map(|b| b.len()).sum::<usize>(), 200);
        for b in batches {
            let ev = ProxyEvent::Audit { records: b };
            assert!(serde_json::to_vec(&ev).unwrap().len() < MAX_PACKET_FROM_PROXY);
        }
    }

    #[test]
    fn oversized_strings_are_clipped() {
        let reason = EgressReason::upstream(nest_protocol::control::UpstreamStage::Exchange, "r".repeat(70_000));
        let mut a = Audit::new(&"h".repeat(70_000), 443, EgressVerdict::Alert).reason(reason);
        a.path = Some("/".repeat(70_000));
        let rec = a.into_record(&SandboxId("sbx_1".into()), Epoch(1), None, None);
        assert!(rec.host.len() <= MAX_HOST && rec.path.as_ref().unwrap().len() <= MAX_PATH);
        assert!(rec.reason.as_ref().unwrap().to_string().len() <= MAX_DETAIL + "exchange: ".len());
        let ev = clip_event(ProxyEvent::Alert {
            ts_ms: 0,
            sandbox: SandboxId("sbx_1".into()),
            epoch: Epoch(1),
            agent: None,
            kind: nest_protocol::host::proxy::AlertKind::DomainFronting,
            host: "x".repeat(70_000),
            binding: Some("b".repeat(70_000)),
            detail: "d".repeat(70_000),
        });
        assert!(serde_json::to_vec(&ev).unwrap().len() < 4096);
    }

    #[test]
    fn path_has_no_query() {
        let uri: http::Uri = "https://api.github.com/repos/x?token=secret".parse().unwrap();
        assert_eq!(path_only(&uri), "/repos/x");
    }
}
