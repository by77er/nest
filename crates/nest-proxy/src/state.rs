//! In-memory state for one nestd connection ("session"). Everything here is discarded when the
//! connection ends; nestd resyncs it on reconnect.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use nest_protocol::control::{EgressAuditKind, EgressAuditRecord, EgressReason, EgressVerdict};
use nest_protocol::host::proxy::{AlertKind, DropReason, ProxyEvent, RESYNC_FAILURES_BYTES, ResyncFailure};
use nest_protocol::model::{AgentId, EgressPolicy, Epoch, ErrorBody, InjectionSecret, SandboxId, WorkstreamId};

use crate::resolve::Resolve;
use crate::tls::{Ca, UpstreamTls};
use crate::util::{clip, now_ms};

/// TTL cap for recorded DNS answers (and the TTL we hand to guests).
pub const DNS_TTL_CAP_MS: i64 = 60_000;

/// Upstream resolutions in flight across the whole proxy (getaddrinfo runs on tokio's shared
/// blocking pool; one sandbox must not be able to occupy it).
pub const RESOLVE_CONCURRENCY: usize = 64;
/// How long a caller waits for a resolver slot before failing.
pub const RESOLVE_QUEUE_TIMEOUT: Duration = Duration::from_secs(5);
/// DNS queries in flight per sandbox; further UDP queries are dropped (clients retry).
pub const DNS_INFLIGHT_PER_SANDBOX: usize = 32;

/// Deny/alert aggregation window per sandbox.
pub const LIMIT_WINDOW_MS: i64 = 60_000;
/// Distinct denied (host, port, reason) records audited per sandbox per window.
pub const MAX_DENIALS_PER_WINDOW: usize = 128;
/// Distinct alerts (kind, host, binding) emitted per sandbox per window.
pub const MAX_ALERTS_PER_WINDOW: usize = 32;

/// Upstream connectivity shared by all sessions.
pub struct Upstream {
    pub resolver: Arc<dyn Resolve>,
    pub tls: UpstreamTls,
    /// Permit loopback/private upstream addresses (tests only; never in production).
    pub allow_private: bool,
    /// Bounds concurrent upstream resolutions (see [`RESOLVE_CONCURRENCY`]).
    pub resolve_slots: Semaphore,
}

impl Upstream {
    pub fn new(resolver: Arc<dyn Resolve>, tls: UpstreamTls, allow_private: bool) -> Self {
        Upstream { resolver, tls, allow_private, resolve_slots: Semaphore::new(RESOLVE_CONCURRENCY) }
    }

    /// Resolve through the shared resolver, bounded by the global concurrency limit.
    pub async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        let _permit = tokio::time::timeout(RESOLVE_QUEUE_TIMEOUT, self.resolve_slots.acquire())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "resolver busy"))?
            .map_err(|_| io::Error::other("resolver closed"))?;
        self.resolver.resolve(host, port).await
    }
}

pub struct Session {
    pub upstream: Arc<Upstream>,
    /// Cancelled when the nestd connection ends: closes every listener and connection.
    pub cancel: CancellationToken,
    lease_until: AtomicI64,
    ca: RwLock<Option<Arc<Ca>>>,
    sandboxes: RwLock<HashMap<SandboxId, Arc<Sandbox>>>,
    /// Sandboxes nestd fenced, with the epoch: state for that epoch (or older) is refused even
    /// if a late upsert/listener push arrives after the drop (fence racing setup).
    dropped: Mutex<HashMap<SandboxId, Epoch>>,
    /// `Some` between `hello_ack` and `resync_complete`: listeners that failed meanwhile, per
    /// sandbox, reported in `resync_ack` instead of one `listener_failed` each.
    resync_failed: Mutex<Option<BTreeMap<SandboxId, Vec<u32>>>>,
    pub events: mpsc::UnboundedSender<ProxyEvent>,
    pub audit_tx: mpsc::Sender<EgressAuditRecord>,
}

impl Session {
    pub fn new(
        upstream: Arc<Upstream>,
        events: mpsc::UnboundedSender<ProxyEvent>,
        audit_tx: mpsc::Sender<EgressAuditRecord>,
    ) -> Arc<Self> {
        Arc::new(Session {
            upstream,
            cancel: CancellationToken::new(),
            lease_until: AtomicI64::new(0),
            ca: RwLock::new(None),
            sandboxes: RwLock::new(HashMap::new()),
            dropped: Mutex::new(HashMap::new()),
            resync_failed: Mutex::new(None),
            events,
            audit_tx,
        })
    }

    /// Fail-closed gate: nestd connected and the host lease mirror unexpired.
    pub fn lease_ok(&self) -> bool {
        !self.cancel.is_cancelled() && now_ms() < self.lease_until.load(Ordering::Relaxed)
    }

    pub fn set_lease(&self, valid_until_ms: i64) {
        self.lease_until.store(valid_until_ms, Ordering::Relaxed);
    }

    pub fn ca(&self) -> Option<Arc<Ca>> {
        self.ca.read().unwrap().clone()
    }

    pub fn set_ca(&self, ca: Arc<Ca>) {
        *self.ca.write().unwrap() = Some(ca);
    }

    pub fn sandbox(&self, id: &SandboxId) -> Option<Arc<Sandbox>> {
        self.sandboxes.read().unwrap().get(id).cloned()
    }

    /// The sandbox for state pushes at `epoch`, created if needed. `None` if nestd already
    /// dropped this sandbox at `epoch` or later: a late push must not resurrect egress.
    pub fn sandbox_for(&self, id: &SandboxId, epoch: Epoch) -> Option<Arc<Sandbox>> {
        {
            let mut dropped = self.dropped.lock().unwrap();
            match dropped.get(id) {
                Some(d) if epoch <= *d => return None,
                Some(_) => {
                    dropped.remove(id); // re-placed at a newer epoch
                }
                None => {}
            }
        }
        let mut map = self.sandboxes.write().unwrap();
        Some(
            map.entry(id.clone())
                .or_insert_with(|| Arc::new(Sandbox::new(id.clone(), epoch, self.cancel.child_token())))
                .clone(),
        )
    }

    /// `sandbox_drop`: remove the sandbox (if its epoch isn't newer). A drop that tombstones (a
    /// fence, [`DropReason::tombstones`], the rule nestd's mirror applies too) is remembered, so a
    /// late push can't resurrect egress; a teardown is not, because a failed create is retried
    /// at the same epoch and must get its egress back.
    pub fn drop_sandbox(&self, id: &SandboxId, epoch: Epoch, reason: DropReason) -> Option<Arc<Sandbox>> {
        if reason.tombstones() {
            let mut dropped = self.dropped.lock().unwrap();
            let e = dropped.entry(id.clone()).or_insert(epoch);
            *e = (*e).max(epoch);
        }
        let mut map = self.sandboxes.write().unwrap();
        if map.get(id).is_some_and(|sb| sb.accepts_epoch(epoch)) { map.remove(id) } else { None }
    }

    /// `hello_ack`: discard everything (nestd is about to resync us).
    pub fn reset(&self) {
        let old: Vec<Arc<Sandbox>> = self.sandboxes.write().unwrap().drain().map(|(_, s)| s).collect();
        for s in old {
            s.drop.cancel();
        }
        self.dropped.lock().unwrap().clear();
        *self.resync_failed.lock().unwrap() = Some(BTreeMap::new());
        *self.ca.write().unwrap() = None;
        self.set_lease(0);
    }

    /// A listener this proxy was handed can't be served (its loop has stopped and its fd is
    /// closed). During a resync it's collected for `resync_ack`; otherwise nestd hears at once.
    pub fn listener_failed(&self, sandbox: &SandboxId, listener_id: u32, error: ErrorBody) {
        tracing::warn!(%sandbox, listener_id, code = %error.code, message = %error.message, "listener failed");
        if let Some(failed) = self.resync_failed.lock().unwrap().as_mut() {
            failed.entry(sandbox.clone()).or_default().push(listener_id);
            return;
        }
        self.emit(ProxyEvent::ListenerFailed { sandbox: sandbox.clone(), listener_id, error });
    }

    /// `resync_complete`: end the resync and take what failed during it, as much as fits
    /// [`RESYNC_FAILURES_BYTES`] of JSON (the rest leave nestd's count unexplained, so it resyncs).
    pub fn finish_resync(&self) -> Vec<ResyncFailure> {
        // Upper bounds of the JSON: one id is at most 10 digits and a comma; one entry's frame is
        // `{"sandbox":"<id>","listener_ids":[]},`.
        const PER_ID: usize = 11;
        const PER_ENTRY: usize = 36;
        let failed = self.resync_failed.lock().unwrap().take().unwrap_or_default();
        let mut room = RESYNC_FAILURES_BYTES;
        let mut out = vec![];
        for (sandbox, mut listener_ids) in failed {
            let frame = PER_ENTRY + sandbox.0.len();
            if room < frame + PER_ID {
                break;
            }
            room -= frame;
            listener_ids.truncate(room / PER_ID);
            room -= listener_ids.len() * PER_ID;
            out.push(ResyncFailure { sandbox, listener_ids });
        }
        out
    }

    pub fn counts(&self) -> (u32, u32) {
        let map = self.sandboxes.read().unwrap();
        let listeners = map.values().map(|s| s.listeners.lock().unwrap().len() as u32).sum();
        (map.len() as u32, listeners)
    }

    pub fn active_connections(&self) -> u32 {
        self.sandboxes.read().unwrap().values().map(|s| s.active.load(Ordering::Relaxed)).sum()
    }

    pub fn emit(&self, ev: ProxyEvent) {
        let _ = self.events.send(ev);
    }
}

#[derive(Clone)]
pub struct SandboxView {
    pub epoch: Epoch,
    pub workstream: Option<WorkstreamId>,
    pub policy: Option<Arc<EgressPolicy>>,
    pub secrets: Arc<HashMap<String, InjectionSecret>>,
}

pub struct Sandbox {
    pub id: SandboxId,
    /// Cancelled by `sandbox_drop` (or session end): closes listeners and established connections.
    pub drop: CancellationToken,
    view: RwLock<SandboxView>,
    pub listeners: Mutex<HashMap<u32, CancellationToken>>,
    pub active: AtomicU32,
    dns: Mutex<HashMap<String, (Vec<IpAddr>, i64)>>,
    /// In-flight DNS queries (see [`DNS_INFLIGHT_PER_SANDBOX`]).
    pub dns_slots: Arc<Semaphore>,
    limiter: Mutex<Limiter>,
}

/// Per-sandbox aggregation of deny/alert records so one guest can't flood nestd and the
/// control plane (random DNS names, repeated fronting attempts).
#[derive(Default)]
struct Limiter {
    window_start: i64,
    denials: HashSet<String>,
    alerts: HashSet<String>,
    suppressed_denials: u64,
    suppressed_alerts: u64,
}

impl Limiter {
    /// Roll the window; returns the previous window's suppressed counts if any.
    fn roll(&mut self, now: i64) -> Option<(u64, u64)> {
        if now - self.window_start < LIMIT_WINDOW_MS {
            return None;
        }
        let prev = (self.suppressed_denials, self.suppressed_alerts);
        *self = Limiter { window_start: now, ..Default::default() };
        (prev != (0, 0)).then_some(prev)
    }
}

/// What to do with a deny/alert-verdict audit record.
pub enum Gate {
    Emit,
    /// Suppressed (duplicate in this window, or over the cap).
    Drop,
}

impl Sandbox {
    fn new(id: SandboxId, epoch: Epoch, drop: CancellationToken) -> Self {
        Sandbox {
            id,
            drop,
            view: RwLock::new(SandboxView { epoch, workstream: None, policy: None, secrets: Arc::new(HashMap::new()) }),
            listeners: Mutex::new(HashMap::new()),
            active: AtomicU32::new(0),
            dns: Mutex::new(HashMap::new()),
            dns_slots: Arc::new(Semaphore::new(DNS_INFLIGHT_PER_SANDBOX)),
            limiter: Mutex::new(Limiter::default()),
        }
    }

    /// Gate a deny/alert audit record: one record per distinct (host, port, reason) per window,
    /// at most [`MAX_DENIALS_PER_WINDOW`] distinct ones. A summary of what was suppressed is
    /// returned (to emit first) when a new window starts.
    pub fn gate_denial(&self, rec: &EgressAuditRecord) -> (Gate, Option<(u64, u64)>) {
        let mut l = self.limiter.lock().unwrap();
        let summary = l.roll(now_ms());
        let key = format!("{}|{}|{}", rec.host, rec.port, rec.reason.as_ref().map(ToString::to_string).unwrap_or_default());
        let gate = if l.denials.contains(&key) || l.denials.len() >= MAX_DENIALS_PER_WINDOW {
            l.suppressed_denials += 1;
            Gate::Drop
        } else {
            l.denials.insert(key);
            Gate::Emit
        };
        (gate, summary)
    }

    /// Gate an alert event: one per distinct (kind, host, binding) per window, capped.
    pub fn gate_alert(&self, kind: AlertKind, host: &str, binding: Option<&str>) -> (Gate, Option<(u64, u64)>) {
        let mut l = self.limiter.lock().unwrap();
        let summary = l.roll(now_ms());
        let key = format!("{kind:?}|{host}|{}", binding.unwrap_or(""));
        let gate = if l.alerts.contains(&key) || l.alerts.len() >= MAX_ALERTS_PER_WINDOW {
            l.suppressed_alerts += 1;
            Gate::Drop
        } else {
            l.alerts.insert(key);
            Gate::Emit
        };
        (gate, summary)
    }

    pub fn view(&self) -> SandboxView {
        self.view.read().unwrap().clone()
    }

    /// Commands for an older epoch than we've seen are stale and ignored.
    pub fn accepts_epoch(&self, epoch: Epoch) -> bool {
        epoch >= self.view.read().unwrap().epoch
    }

    /// Apply a policy push; returns false if ignored (stale epoch or not-newer version).
    pub fn upsert(&self, epoch: Epoch, workstream: Option<WorkstreamId>, policy: EgressPolicy) -> bool {
        let mut v = self.view.write().unwrap();
        if epoch < v.epoch {
            return false;
        }
        if epoch == v.epoch && v.policy.as_ref().is_some_and(|p| policy.version <= p.version) {
            return false;
        }
        v.epoch = epoch;
        v.workstream = workstream;
        v.policy = Some(Arc::new(policy));
        true
    }

    pub fn set_secrets(&self, epoch: Epoch, secrets: Vec<InjectionSecret>) -> bool {
        let mut v = self.view.write().unwrap();
        if epoch < v.epoch {
            return false;
        }
        v.epoch = epoch;
        v.secrets = Arc::new(secrets.into_iter().map(|s| (s.binding.clone(), s)).collect());
        true
    }

    pub fn record_dns(&self, name: &str, ips: &[IpAddr]) {
        let exp = now_ms() + DNS_TTL_CAP_MS;
        self.dns.lock().unwrap().insert(name.to_string(), (ips.to_vec(), exp));
    }

    /// Unexpired addresses our resolver previously returned to this sandbox for `name`.
    pub fn dns_ips(&self, name: &str) -> Vec<IpAddr> {
        let now = now_ms();
        let mut map = self.dns.lock().unwrap();
        map.retain(|_, (_, exp)| *exp > now);
        map.get(name).map(|(ips, _)| ips.clone()).unwrap_or_default()
    }

    /// Reserve a connection slot under the policy's `max_connections`.
    pub fn try_acquire(self: &Arc<Self>) -> Option<ConnGuard> {
        let max = self.view().policy.map(|p| p.limits.max_connections).unwrap_or(0);
        let prev = self.active.fetch_add(1, Ordering::AcqRel);
        if max == 0 || prev >= max {
            self.active.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(ConnGuard(self.clone()))
    }
}

pub struct ConnGuard(Arc<Sandbox>);

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Everything a connection handler needs: who it's for and where to report.
pub struct ConnCtx {
    pub session: Arc<Session>,
    pub sandbox: Arc<Sandbox>,
    /// Known for explicit (per-agent) listeners only.
    pub agent: Option<AgentId>,
    /// Entry point that accepted the connection (audit `via`).
    pub via: nest_protocol::control::EgressVia,
    pub _guard: ConnGuard,
}

impl ConnCtx {
    pub fn view(&self) -> SandboxView {
        self.sandbox.view()
    }

    pub fn audit(&self, a: crate::audit::Audit) {
        let rec = a.into_record(&self.sandbox.id, self.view().epoch, self.agent.clone(), Some(self.via));
        submit_audit(&self.session, &self.sandbox, rec);
    }

    pub fn alert(&self, kind: AlertKind, host: &str, binding: Option<&str>, detail: impl Into<String>) {
        let (gate, summary) = self.sandbox.gate_alert(kind, host, binding);
        if let Some(counts) = summary {
            submit_summary(&self.session, &self.sandbox, counts);
        }
        if matches!(gate, Gate::Drop) {
            return;
        }
        self.session.emit(ProxyEvent::Alert {
            ts_ms: now_ms(),
            sandbox: self.sandbox.id.clone(),
            epoch: self.view().epoch,
            agent: self.agent.clone(),
            kind,
            host: clip(host, crate::audit::MAX_HOST),
            binding: binding.map(|b| clip(b, crate::audit::MAX_SHORT)),
            detail: clip(&detail.into(), crate::audit::MAX_DETAIL),
        });
    }

    /// Lease valid and sandbox not dropped: required for new upstream work and for injection.
    pub fn live(&self) -> bool {
        self.session.lease_ok() && !self.sandbox.drop.is_cancelled()
    }
}

/// Queue an audit record, aggregating deny/alert verdicts per sandbox (see [`Sandbox::gate_denial`]).
pub fn submit_audit(session: &Session, sandbox: &Sandbox, rec: EgressAuditRecord) {
    if matches!(rec.verdict, EgressVerdict::Deny | EgressVerdict::Alert) {
        let (gate, summary) = sandbox.gate_denial(&rec);
        if let Some(counts) = summary {
            submit_summary(session, sandbox, counts);
        }
        if matches!(gate, Gate::Drop) {
            return;
        }
    }
    let _ = session.audit_tx.try_send(rec);
}

/// The previous window's summary: a `suppressed` record (host `*`, port 0) with the counts.
fn submit_summary(session: &Session, sandbox: &Sandbox, (denials, alerts): (u64, u64)) {
    let mut a = crate::audit::Audit::new("*", 0, EgressVerdict::Deny).reason(EgressReason::Suppressed);
    a.count = Some(u32::try_from(denials + alerts).unwrap_or(u32::MAX));
    a.kind = EgressAuditKind::Suppressed { denials, alerts };
    let _ = session.audit_tx.try_send(a.into_record(&sandbox.id, sandbox.view().epoch, None, None));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::Audit;

    type Channels = (Arc<Session>, mpsc::UnboundedReceiver<ProxyEvent>, mpsc::Receiver<EgressAuditRecord>);

    fn session() -> Channels {
        let tls = UpstreamTls::new(false, &[]).unwrap();
        let upstream = Arc::new(Upstream::new(Arc::new(crate::resolve::StaticResolver::new()), tls, true));
        let (etx, erx) = mpsc::unbounded_channel();
        let (atx, arx) = mpsc::channel(64);
        (Session::new(upstream, etx, atx), erx, arx)
    }

    fn deny(sbx: &Sandbox, host: &str) -> EgressAuditRecord {
        Audit::new(host, 443, EgressVerdict::Deny).reason(EgressReason::NotAllowed).into_record(&sbx.id, Epoch(1), None, None)
    }

    /// Guest-proxy review #2: a window's summary is a `suppressed` record with its counts, never
    /// a policy denial of host `*`.
    #[test]
    fn the_suppression_summary_is_its_own_kind() {
        let (s, _events, mut audit) = session();
        let sbx = s.sandbox_for(&SandboxId("sbx_1".into()), Epoch(1)).unwrap();
        submit_audit(&s, &sbx, deny(&sbx, "a.example"));
        submit_audit(&s, &sbx, deny(&sbx, "a.example"));
        assert!(audit.try_recv().unwrap().is_policy_denial());
        assert!(audit.try_recv().is_err(), "the duplicate is suppressed");
        sbx.limiter.lock().unwrap().window_start -= LIMIT_WINDOW_MS; // the window ends
        submit_audit(&s, &sbx, deny(&sbx, "b.example"));
        let summary = audit.try_recv().unwrap();
        assert_eq!(summary.kind, EgressAuditKind::Suppressed { denials: 1, alerts: 0 });
        assert_eq!((summary.reason.clone(), summary.count, summary.host.as_str(), summary.port), (Some(EgressReason::Suppressed), Some(1), "*", 0));
        assert!(!summary.is_policy_denial());
        assert_eq!(audit.try_recv().unwrap().host, "b.example");
    }

    /// Guest-proxy review #6: listeners that fail during a resync are reported in `resync_ack`,
    /// grouped per sandbox; after it, each is reported on its own at once.
    #[test]
    fn listener_failures_during_a_resync_go_into_the_ack() {
        let (s, mut events, _audit) = session();
        let err = || ErrorBody { code: "x".into(), message: "y".into(), retryable: true };
        let (a, b) = (SandboxId("sbx_a".into()), SandboxId("sbx_b".into()));
        s.reset(); // hello_ack
        s.listener_failed(&a, 3, err());
        s.listener_failed(&b, 1, err());
        s.listener_failed(&a, 4, err());
        assert!(events.try_recv().is_err(), "no listener_failed during a resync");
        let want = vec![ResyncFailure { sandbox: a.clone(), listener_ids: vec![3, 4] }, ResyncFailure { sandbox: b, listener_ids: vec![1] }];
        assert_eq!(s.finish_resync(), want);
        s.listener_failed(&a, 5, err());
        assert!(matches!(events.try_recv().unwrap(), ProxyEvent::ListenerFailed { listener_id: 5, .. }));
        assert!(s.finish_resync().is_empty());
    }

    /// However many listeners fail in a resync, the ack still fits one packet to nestd.
    #[test]
    fn a_huge_failure_list_still_fits_the_ack() {
        let (s, _events, _audit) = session();
        let err = || ErrorBody { code: "x".into(), message: "y".into(), retryable: true };
        s.reset();
        for n in 0..3000u32 {
            let sbx = SandboxId(format!("sbx_{}", "a".repeat(40) + &n.to_string()));
            for id in [u32::MAX - 1, u32::MAX - 2] {
                s.listener_failed(&sbx, id, err());
            }
        }
        let failed = s.finish_resync();
        assert!(!failed.is_empty());
        let budget = serde_json::to_vec(&failed).unwrap().len();
        assert!(budget <= RESYNC_FAILURES_BYTES, "{budget} bytes of failures");
        let ack = ProxyEvent::ResyncAck { sandboxes: u32::MAX, listeners: u32::MAX, failed };
        let len = serde_json::to_vec(&ack).unwrap().len();
        assert!(len <= nest_protocol::host::fdpass::MAX_PACKET_FROM_PROXY, "{len} bytes");
    }
}
