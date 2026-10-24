//! In-memory state for one nestd connection ("session"). Everything here is discarded when the
//! connection ends; nestd resyncs it on reconnect.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

use nest_protocol::control::{EgressAuditRecord, EgressVerdict};
use nest_protocol::host::proxy::{AlertKind, DropReason, ProxyEvent};
use nest_protocol::model::{AgentId, EgressPolicy, Epoch, InjectionSecret, SandboxId, WorkstreamId};

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
        *self.ca.write().unwrap() = None;
        self.set_lease(0);
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
    pub fn gate_denial(&self, rec: &EgressAuditRecord) -> (Gate, Option<(String, u32)>) {
        let mut l = self.limiter.lock().unwrap();
        let summary = l.roll(now_ms()).map(summary_reason);
        let key = format!("{}|{}|{}", rec.host, rec.port, rec.reason.as_deref().unwrap_or(""));
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
    pub fn gate_alert(&self, kind: AlertKind, host: &str, binding: Option<&str>) -> (Gate, Option<(String, u32)>) {
        let mut l = self.limiter.lock().unwrap();
        let summary = l.roll(now_ms()).map(summary_reason);
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
        if let Some(reason) = summary {
            submit_summary(&self.session, &self.sandbox, reason);
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
        if let Some(reason) = summary {
            submit_summary(session, sandbox, reason);
        }
        if matches!(gate, Gate::Drop) {
            return;
        }
    }
    let _ = session.audit_tx.try_send(rec);
}

fn submit_summary(session: &Session, sandbox: &Sandbox, (reason, count): (String, u32)) {
    let mut a = crate::audit::Audit::new("*", 0, EgressVerdict::Deny).reason(reason);
    a.count = Some(count);
    let _ = session.audit_tx.try_send(a.into_record(&sandbox.id, sandbox.view().epoch, None, None));
}

fn summary_reason((denials, alerts): (u64, u64)) -> (String, u32) {
    let reason = format!("suppressed: {denials} duplicate or excess deny records and {alerts} alerts in the previous {}s window", LIMIT_WINDOW_MS / 1000);
    (reason, u32::try_from(denials + alerts).unwrap_or(u32::MAX))
}
