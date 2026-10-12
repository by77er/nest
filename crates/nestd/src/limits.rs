//! Per-sandbox token buckets for guest- and proxy-originated events (`docs/compute/nestd/`).
//!
//! Everything a sandbox can make nestd emit (egress denials and alerts, audit records, port
//! changes, `nest` CLI relays, task exits) is bounded per sandbox, so one sandbox can't flood the
//! control plane or starve the host. Excess is dropped (and counted in logs), never queued.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

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

/// Egress-denied workstream events (each may wake a captain).
pub const DENIED: Rate = Rate::per_min(30.0, 30.0);
/// Egress-alert workstream events.
pub const ALERTS: Rate = Rate::per_min(10.0, 10.0);
/// Audit records forwarded to the control plane.
pub const AUDIT_RECORDS: Rate = Rate::per_min(2000.0, 2000.0);
/// Port-opened workstream events.
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
    /// Take `cost` tokens of `kind` for `sandbox`; `false` (and the drop is counted) if empty.
    pub fn allow(&self, sandbox: &SandboxId, kind: &'static str, rate: Rate, cost: f64) -> bool {
        let mut map = self.buckets.lock().expect("limiter");
        let now = Instant::now();
        let b = map.entry((sandbox.clone(), kind)).or_insert(Bucket { tokens: rate.burst, last: now, dropped: 0 });
        b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * rate.per_sec).min(rate.burst);
        b.last = now;
        if b.tokens >= cost {
            b.tokens -= cost;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_allows_burst_then_drops() {
        let l = Limiter::default();
        let s = SandboxId("sbx_1".into());
        let r = Rate { per_sec: 0.0, burst: 3.0 };
        assert!((0..3).all(|_| l.allow(&s, "x", r, 1.0)));
        assert!(!l.allow(&s, "x", r, 1.0));
        // Separate per sandbox and per kind.
        assert!(l.allow(&SandboxId("sbx_2".into()), "x", r, 1.0));
        assert!(l.allow(&s, "y", r, 1.0));
        l.forget(&s);
        assert!(l.allow(&s, "x", r, 1.0));
    }
}
