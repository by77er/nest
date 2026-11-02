//! Per-sandbox token buckets for guest- and proxy-originated events (`docs/compute/nestd/`).
//!
//! Everything a sandbox can make nestd emit (egress denials and alerts, audit records, port
//! changes, `nest` CLI relays, task exits) is bounded per sandbox, so one sandbox can't flood the
//! control plane or starve the host. Excess is dropped (and counted in logs), never queued.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use nest_protocol::model::SandboxId;

/// A rate class: sustained `per_sec`, bursts up to `burst`.
#[derive(Clone, Copy, Debug)]
pub struct Rate {
    pub per_sec: f64,
    pub burst: f64,
}

impl Rate {
    pub const fn per_min(n: f64, burst: f64) -> Rate {
        Rate { per_sec: n / 60.0, burst }
    }
}

/// Egress-denied sandbox events.
pub const DENIED: Rate = Rate::per_min(30.0, 30.0);
/// Egress-alert sandbox events.
pub const ALERTS: Rate = Rate::per_min(10.0, 10.0);
/// Audit records forwarded to the control plane.
pub const AUDIT_RECORDS: Rate = Rate::per_min(2000.0, 2000.0);
/// Port-opened sandbox events.
pub const PORTS: Rate = Rate::per_min(20.0, 20.0);
/// `nest` CLI relays started.
pub const CLI: Rate = Rate { per_sec: 5.0, burst: 20.0 };
/// Task-exited events.
pub const TASKS: Rate = Rate { per_sec: 10.0, burst: 50.0 };
/// Maximum concurrent CLI relays per sandbox (an `ask` may wait 2 minutes).
pub const MAX_CLI_INFLIGHT: u32 = 16;

struct Bucket {
    tokens: f64,
    last: Instant,
    dropped: u64,
}

#[derive(Default)]
pub struct Limiter {
    buckets: Mutex<HashMap<(SandboxId, &'static str), Bucket>>,
}

impl Limiter {
    /// Take a token of `kind` for `sandbox`; `false` (and the drop is counted) if empty.
    pub fn allow(&self, sandbox: &SandboxId, kind: &'static str, rate: Rate) -> bool {
        let mut map = self.buckets.lock().expect("limiter");
        let now = Instant::now();
        let b = map.entry((sandbox.clone(), kind)).or_insert(Bucket { tokens: rate.burst, last: now, dropped: 0 });
        b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * rate.per_sec).min(rate.burst);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            true
        } else {
            b.dropped += 1;
            if b.dropped.is_power_of_two() {
                tracing::warn!(%sandbox, kind, dropped = b.dropped, "rate limit: dropping sandbox events");
            }
            false
        }
    }

    /// Forget a sandbox's buckets (teardown).
    pub fn forget(&self, sandbox: &SandboxId) {
        self.buckets.lock().expect("limiter").retain(|(s, _), _| s != sandbox);
    }
}

/// Keys seen within the last `ttl`, at most `cap` of them: a repeat inside the window (which a
/// repeat extends) isn't fresh, so it isn't reported again.
pub struct RecentSet<K> {
    seen: Mutex<HashMap<K, Instant>>,
    ttl: Duration,
    cap: usize,
}

impl<K: Hash + Eq> RecentSet<K> {
    pub fn new(ttl: Duration, cap: usize) -> RecentSet<K> {
        RecentSet { seen: Mutex::new(HashMap::new()), ttl, cap }
    }

    /// Whether `key` is new within the window; records it either way. When full, a new key is
    /// not fresh: random names can't grow the set without limit.
    pub fn fresh(&self, key: K) -> bool {
        self.fresh_at(key, Instant::now())
    }

    fn fresh_at(&self, key: K, now: Instant) -> bool {
        let mut seen = self.seen.lock().expect("recent set");
        seen.retain(|_, t| now.duration_since(*t) < self.ttl);
        if seen.len() >= self.cap && !seen.contains_key(&key) {
            return false;
        }
        seen.insert(key, now).is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recent_key_is_fresh_once_per_window_and_the_set_is_bounded() {
        let set = RecentSet::new(Duration::from_secs(60), 2);
        let t0 = Instant::now();
        assert!(set.fresh_at("a", t0));
        assert!(!set.fresh_at("a", t0 + Duration::from_secs(59)), "a repeat within the window");
        assert!(!set.fresh_at("a", t0 + Duration::from_secs(118)), "the repeat extended the window");
        assert!(set.fresh_at("a", t0 + Duration::from_secs(179)), "the window passed");
        assert!(set.fresh_at("b", t0 + Duration::from_secs(179)));
        assert!(!set.fresh_at("c", t0 + Duration::from_secs(179)), "full: a new key isn't fresh");
        assert!(set.fresh_at("c", t0 + Duration::from_secs(240)), "the old keys expired");
    }

    #[test]
    fn bucket_allows_burst_then_drops() {
        let l = Limiter::default();
        let s = SandboxId("sbx_1".into());
        let r = Rate { per_sec: 0.0, burst: 3.0 };
        assert!((0..3).all(|_| l.allow(&s, "x", r)));
        assert!(!l.allow(&s, "x", r));
        // Separate per sandbox and per kind.
        assert!(l.allow(&SandboxId("sbx_2".into()), "x", r));
        assert!(l.allow(&s, "y", r));
        l.forget(&s);
        assert!(l.allow(&s, "x", r));
    }
}
