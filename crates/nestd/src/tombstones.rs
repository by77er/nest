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
//!
//! The logic is [`nestd_core::incarnation::TombstoneMap`] (proved there with Kani); this shares
//! one behind a lock and converts the protocol's types.

use std::sync::{Arc, Mutex, MutexGuard};

use nest_protocol::model::{Epoch, SandboxId};
use nestd_core::incarnation::TombstoneMap;

/// Highest fenced epoch per sandbox; nothing at or below it is accepted. Cheap to clone (shared).
/// Its lock is a leaf: taken inside the links' own locks, never around another lock.
#[derive(Clone, Default)]
pub struct Tombstones(Arc<Mutex<TombstoneMap<SandboxId>>>);

impl Tombstones {
    fn map(&self) -> MutexGuard<'_, TombstoneMap<SandboxId>> {
        self.0.lock().expect("tombstones")
    }

    /// `sandbox@epoch` was fenced: refuse it and every older epoch from now on.
    pub fn fence(&self, sandbox: &SandboxId, epoch: Epoch) {
        self.map().fence(sandbox, epoch.0);
    }

    /// Whether `sandbox@epoch` is at or below a fenced epoch.
    pub fn refuses(&self, sandbox: &SandboxId, epoch: Epoch) -> bool {
        self.map().refuses(sandbox, epoch.0)
    }

    /// Drop the sandbox's tombstone if it is at or below `epoch` (the sandbox was destroyed at
    /// that epoch). A tombstone above `epoch` stays.
    pub fn prune_up_to(&self, sandbox: &SandboxId, epoch: Epoch) {
        self.map().prune_up_to(sandbox, epoch.0);
    }

    /// Drop the sandbox's tombstone if it is below `epoch` (that newer epoch now runs here).
    pub fn prune_below(&self, sandbox: &SandboxId, epoch: Epoch) {
        self.map().prune_below(sandbox, epoch.0);
    }

    /// The fenced epoch recorded for `sandbox`, if any.
    pub fn get(&self, sandbox: &SandboxId) -> Option<Epoch> {
        self.map().get(sandbox).map(Epoch)
    }

    pub fn len(&self) -> usize {
        self.map().len()
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

    /// Sandboxes don't share tombstones: fencing or pruning one leaves another's alone.
    #[test]
    fn each_sandbox_has_its_own_tombstone() {
        let t = Tombstones::default();
        let (a, b) = (SandboxId("sbx_a".into()), SandboxId("sbx_b".into()));
        t.fence(&a, Epoch(5));
        t.fence(&b, Epoch(2));
        assert_eq!(t.len(), 2);
        t.prune_below(&b, Epoch(9));
        assert_eq!((t.get(&a), t.get(&b)), (Some(Epoch(5)), None));
        assert!(t.refuses(&a, Epoch(5)) && !t.refuses(&b, Epoch(2)));
    }
}
