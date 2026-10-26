//! Per-sandbox DNS: only names the policy allows resolve; everything else gets NXDOMAIN and is
//! never forwarded upstream (blocking exfiltration through queries). Answers are recorded per
//! sandbox so TCP exceptions can be limited to resolver-returned addresses.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use hickory_proto::op::{Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA};
use hickory_proto::rr::{RData, Record, RecordType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

use nest_protocol::control::EgressVerdict;
use nest_protocol::model::EgressPolicy;

use crate::audit::Audit;
use crate::state::{DNS_TTL_CAP_MS, Sandbox, Session, submit_audit};
use crate::util::{norm_host, now_ms};

const TTL_SECS: u32 = (DNS_TTL_CAP_MS / 1000) as u32;
const MAX_UDP: usize = 4096;
const TCP_IDLE: Duration = Duration::from_secs(10);

/// May `name` be resolved for this sandbox?
pub fn name_allowed(policy: &EgressPolicy, name: &str, now: i64) -> bool {
    policy.allow.iter().any(|r| r.host.matches(name) && r.expires_ms.is_none_or(|e| now < e))
        || policy.tcp.iter().any(|t| norm_host(&t.host) == name)
}

/// Answer one DNS query packet. Returns `None` for unparseable input (dropped silently).
pub async fn answer(session: &Session, sandbox: &Sandbox, query: &[u8]) -> Option<Vec<u8>> {
    let req = Message::from_vec(query).ok()?;
    if req.metadata.message_type != MessageType::Query {
        return None;
    }
    let mut resp = Message::new(req.metadata.id, MessageType::Response, req.metadata.op_code);
    resp.metadata.recursion_desired = req.metadata.recursion_desired;
    resp.metadata.recursion_available = true;
    resp.add_queries(req.queries.iter().cloned());

    let rcode = 'r: {
        if req.metadata.op_code != OpCode::Query || req.queries.len() != 1 {
            break 'r ResponseCode::NotImp;
        }
        if !session.lease_ok() || sandbox.drop.is_cancelled() {
            break 'r ResponseCode::Refused;
        }
        let q = &req.queries[0];
        let name = norm_host(&q.name().to_ascii());
        let view = sandbox.view();
        let Some(policy) = view.policy else { break 'r ResponseCode::Refused };
        if !name_allowed(&policy, &name, now_ms()) {
            let a = Audit::new(&name, 53, EgressVerdict::Deny).reason(nest_protocol::control::EgressReason::DnsNxdomain);
            submit_audit(session, sandbox, a.into_record(&sandbox.id, view.epoch, None, Some(nest_protocol::control::EgressVia::Dns)));
            break 'r ResponseCode::NXDomain;
        }
        let want = q.query_type();
        if want != RecordType::A && want != RecordType::AAAA {
            break 'r ResponseCode::NoError; // allowed name, no data for other types
        }
        let ips: Vec<IpAddr> = match session.upstream.resolve(&name, 0).await {
            Ok(addrs) => {
                let mut ips: Vec<IpAddr> = addrs.into_iter().map(|a| a.ip()).collect();
                ips.dedup();
                ips
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break 'r ResponseCode::NXDomain,
            Err(_) => break 'r ResponseCode::ServFail,
        };
        sandbox.record_dns(&name, &ips);
        for ip in ips {
            let rdata = match (ip, want) {
                (IpAddr::V4(v4), RecordType::A) => RData::A(A(v4)),
                (IpAddr::V6(v6), RecordType::AAAA) => RData::AAAA(AAAA(v6)),
                _ => continue,
            };
            resp.add_answer(Record::from_rdata(q.name().clone(), TTL_SECS, rdata));
        }
        ResponseCode::NoError
    };
    resp.metadata.response_code = rcode;
    resp.to_vec().ok()
}

pub async fn serve_udp(session: Arc<Session>, sandbox: Arc<Sandbox>, sock: UdpSocket, stop: tokio_util::sync::CancellationToken) {
    let sock = Arc::new(sock);
    let mut buf = vec![0u8; MAX_UDP];
    loop {
        let (n, peer) = tokio::select! {
            _ = stop.cancelled() => return,
            r = sock.recv_from(&mut buf) => match r {
                Ok(v) => v,
                Err(e) => { tracing::debug!("dns udp recv: {e}"); tokio::time::sleep(Duration::from_millis(20)).await; continue }
            },
        };
        // Bounded per sandbox: when every slot is busy the query is dropped (clients retry),
        // so a flood can't spawn unbounded tasks or monopolize the shared resolver.
        let Ok(permit) = sandbox.dns_slots.clone().try_acquire_owned() else { continue };
        let pkt = buf[..n].to_vec();
        let (session, sandbox, sock) = (session.clone(), sandbox.clone(), sock.clone());
        tokio::spawn(async move {
            let _permit = permit;
            if let Some(resp) = answer(&session, &sandbox, &pkt).await {
                let _ = sock.send_to(&resp, peer).await;
            }
        });
    }
}

/// DNS over TCP: 2-byte length-prefixed messages until idle or EOF.
pub async fn serve_tcp_conn(session: Arc<Session>, sandbox: Arc<Sandbox>, mut s: TcpStream) {
    loop {
        let mut len = [0u8; 2];
        match tokio::time::timeout(TCP_IDLE, s.read_exact(&mut len)).await {
            Ok(Ok(_)) => {}
            _ => return,
        }
        let mut msg = vec![0u8; u16::from_be_bytes(len) as usize];
        if tokio::time::timeout(TCP_IDLE, s.read_exact(&mut msg)).await.is_err() {
            return;
        }
        let Ok(_permit) = sandbox.dns_slots.clone().acquire_owned().await else { return };
        let Some(resp) = answer(&session, &sandbox, &msg).await else { return };
        let mut out = (resp.len() as u16).to_be_bytes().to_vec();
        out.extend_from_slice(&resp);
        if s.write_all(&out).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::{AllowRule, EgressLimits, HostPattern, PolicyLayer, TcpException};

    #[test]
    fn allowlist() {
        let p = EgressPolicy {
            version: 1,
            allow: vec![
                AllowRule { host: HostPattern("*.githubusercontent.com".into()), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None },
                AllowRule { host: HostPattern("old.example".into()), ports: vec![443], layer: PolicyLayer::Sandbox, expires_ms: Some(10) },
            ],
            passthrough: vec![],
            inject: vec![],
            tcp: vec![TcpException { host: "db.example.com".into(), port: 5432 }],
            limits: EgressLimits { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 },
        };
        assert!(name_allowed(&p, "raw.githubusercontent.com", 0));
        assert!(!name_allowed(&p, "githubusercontent.com", 0));
        assert!(name_allowed(&p, "db.example.com", 0));
        assert!(name_allowed(&p, "old.example", 5));
        assert!(!name_allowed(&p, "old.example", 10));
        assert!(!name_allowed(&p, "evil.com", 0));
    }
}
