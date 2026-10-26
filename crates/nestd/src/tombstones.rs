//! Fenced-epoch tombstones: the one record of which sandbox epochs are over on this host because
//! they were fenced. The host core is the only writer (`fence_sandbox` records the epoch before it
//! drops the sandbox from nest-proxy and the gateway); the proxy link and the gateway link consult
//! it and refuse anything for a tombstoned epoch, so a late update can never re-add a fenced
//! sandbox to either. A create at a tombstoned epoch answers `stale_epoch`.
//!
//! Bounded by the sandboxes this host has fenced and not yet let go, the same lifetime as their
//! `fenced` summary rows: a sandbox's tombstone is pruned when a newer epoch of it runs here (the
//! summary's epoch check refuses older ones from then on) or when it is destroyed at or above
//! that epoch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use nest_protocol::model::{Epoch, SandboxId};
use nestd_core::incarnation;

/// Highest fenced epoch per sandbox; nothing at or below it is accepted. Cheap to clone (shared).
/// Its lock is a leaf: taken inside the links' own locks, never around another lock.
#[derive(Clone, Default)]
pub struct Tombstones(Arc<Mutex<HashMap<SandboxId, Epoch>>>);

impl Tombstones {
    /// `sandbox@epoch` was fenced: refuse it and every older epoch from now on.
    pub fn fence(&self, sandbox: &SandboxId, epoch: Epoch) {
        let mut m = self.0.lock().expect("tombstones");
        let fenced = incarnation::fenced_after(m.get(sandbox).map(|f| f.0), epoch.0);
        m.insert(sandbox.clone(), Epoch(fenced));
    }

    /// Whether `sandbox@epoch` is at or below a fenced epoch.
    pub fn refuses(&self, sandbox: &SandboxId, epoch: Epoch) -> bool {
        incarnation::refuses(self.0.lock().expect("tombstones").get(sandbox).map(|f| f.0), epoch.0)
    }

    /// Drop the sandbox's tombstone if it is at or below `epoch` (the sandbox was destroyed at
    /// that epoch). A tombstone above `epoch` stays.
    pub fn prune_up_to(&self, sandbox: &SandboxId, epoch: Epoch) {
        let mut m = self.0.lock().expect("tombstones");
        if m.get(sandbox).is_some_and(|f| incarnation::destroy_prunes(f.0, epoch.0)) {
            m.remove(sandbox);
        }
    }

    /// Drop the sandbox's tombstone if it is below `epoch` (that newer epoch now runs here).
    pub fn prune_below(&self, sandbox: &SandboxId, epoch: Epoch) {
        let mut m = self.0.lock().expect("tombstones");
        if m.get(sandbox).is_some_and(|f| incarnation::run_prunes(f.0, epoch.0)) {
            m.remove(sandbox);
        }
    }

    /// The fenced epoch recorded for `sandbox`, if any.
    pub fn get(&self, sandbox: &SandboxId) -> Option<Epoch> {
        self.0.lock().expect("tombstones").get(sandbox).copied()
    }

    pub fn len(&self) -> usize {
        self.0.lock().expect("tombstones").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fence refuses its epoch and older ones; pruning lets go only of what is at or below the
    /// given epoch, so the map does not grow with every sandbox ever fenced here.
    #[test]
    fn fence_refuses_and_prune_lets_go() {
        let t = Tombstones::default();
        let s = SandboxId("sbx_1".into());
        t.fence(&s, Epoch(3));
        t.fence(&s, Epoch(2)); // never lowers
        assert!(t.refuses(&s, Epoch(3)) && t.refuses(&s, Epoch(1)));
        assert!(!t.refuses(&s, Epoch(4)));
        t.prune_up_to(&s, Epoch(2));
        assert_eq!(t.get(&s), Some(Epoch(3)), "a destroy below the fenced epoch keeps it");
        t.prune_below(&s, Epoch(3));
        assert_eq!(t.get(&s), Some(Epoch(3)), "a create at the fenced epoch itself never clears it");
        t.prune_up_to(&s, Epoch(4));
        assert!(t.is_empty());
        assert!(!t.refuses(&s, Epoch(3)));
    }
}
