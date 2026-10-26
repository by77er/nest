//! Command dedup: the bounded `cmd` → outcome cache the executor consults before running a
//! command, so a redelivered command (a resend after a reconnect) answers with its first outcome
//! instead of running again.
//!
//! Ordered maps only, never a hashed one: its hasher seeds itself from the OS, which a core must not
//! touch, and Kani can't reason about it.

use std::collections::{BTreeMap, VecDeque};

/// How many outcomes nestd keeps: far more than FleetDO can have unacked at once.
pub const RESULTS_KEPT: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ResultCache<V> {
    cap: usize,
    map: BTreeMap<String, V>,
    /// Insertion order of the keys in `map`, oldest first.
    order: VecDeque<String>,
}

impl<V> Default for ResultCache<V> {
    fn default() -> Self {
        Self::new(RESULTS_KEPT)
    }
}

impl<V> ResultCache<V> {
    pub fn new(cap: usize) -> Self {
        Self { cap, map: BTreeMap::new(), order: VecDeque::new() }
    }

    /// The outcome recorded for `cmd`, if it ran (and hasn't been evicted).
    pub fn get(&self, cmd: &str) -> Option<&V> {
        self.map.get(cmd)
    }

    /// Record `cmd`'s outcome. A key already present keeps its place (its value is replaced); a new
    /// one past the bound evicts the oldest.
    pub fn insert(&mut self, cmd: &str, outcome: V) {
        if self.map.insert(cmd.to_string(), outcome).is_none() {
            self.order.push_back(cmd.to_string());
            if self.order.len() > self.cap
                && let Some(old) = self.order.pop_front()
            {
                self.map.remove(&old);
            }
        }
        crate::invariant::check(self.map.len() == self.order.len() && self.map.len() <= self.cap, "result_cache_bounded");
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::ResultCache;

    /// Characterization of the cache `host.rs` used before the extraction: first outcome is
    /// returned, a re-insert keeps the key's age, and the oldest key goes past the bound.
    #[test]
    fn keeps_outcomes_up_to_its_bound_evicting_the_oldest() {
        let mut c = ResultCache::new(2);
        c.insert("a", 1);
        c.insert("b", 2);
        c.insert("a", 3); // replaced in place, still the oldest
        assert_eq!(c.get("a"), Some(&3));
        c.insert("c", 4);
        assert_eq!(c.get("a"), None, "the oldest key is evicted");
        assert_eq!((c.get("b"), c.get("c"), c.len()), (Some(&2), Some(&4), 2));
    }
}
