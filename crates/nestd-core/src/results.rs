//! Command dedup: the bounded `cmd` → outcome cache the executor consults before running a
//! command, so a redelivered command (a resend after a reconnect) answers with its first outcome
//! instead of running again.
//!
//! Ordered maps only, never a hashed one: its hasher seeds itself from the OS, which a core must not
//! touch, and Kani can't reason about it.

use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};

/// How many outcomes nestd keeps: far more than FleetDO can have unacked at once.
pub const RESULTS_KEPT: usize = 4096;

/// The map a [`ResultCache`] keeps its outcomes in: a `BTreeMap` in nestd.
///
/// This and [`KeyOrder`] exist for the Kani harness, which swaps in fixed arrays: over a
/// `BTreeMap` and a `VecDeque`, Kani 0.68 did not finish even a cap of 1 with two inserts in five
/// minutes (a `VecDeque` whose popped keys are used is enough to stall it). The cache's own logic is
/// the same code either way; the std collections are trusted to be a map and a FIFO.
pub trait OutcomeMap<K, V>: Default {
    fn get<Q: Ord + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>;
    /// Insert or replace; the value replaced, if any.
    fn insert(&mut self, key: K, value: V) -> Option<V>;
    fn remove(&mut self, key: &K);
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The insertion order a [`ResultCache`] evicts by, oldest first: a `VecDeque` in nestd.
pub trait KeyOrder<K>: Default {
    fn push_back(&mut self, key: K);
    fn pop_front(&mut self) -> Option<K>;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<K: Ord, V> OutcomeMap<K, V> for BTreeMap<K, V> {
    fn get<Q: Ord + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        BTreeMap::get(self, key)
    }

    fn insert(&mut self, key: K, value: V) -> Option<V> {
        BTreeMap::insert(self, key, value)
    }

    fn remove(&mut self, key: &K) {
        BTreeMap::remove(self, key);
    }

    fn len(&self) -> usize {
        BTreeMap::len(self)
    }
}

impl<K> KeyOrder<K> for VecDeque<K> {
    fn push_back(&mut self, key: K) {
        VecDeque::push_back(self, key)
    }

    fn pop_front(&mut self) -> Option<K> {
        VecDeque::pop_front(self)
    }

    fn len(&self) -> usize {
        VecDeque::len(self)
    }
}

/// Keyed by command id (`String`), in a `BTreeMap` and a `VecDeque`; generic so the Kani harness
/// can use small integer keys and fixed-array collections.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ResultCache<V, K = String, M = BTreeMap<K, V>, O = VecDeque<K>> {
    cap: usize,
    map: M,
    /// Insertion order of the keys in `map`, oldest first.
    order: O,
    _entries: std::marker::PhantomData<(K, V)>,
}

impl<V, K: Clone, M: OutcomeMap<K, V>, O: KeyOrder<K>> Default for ResultCache<V, K, M, O> {
    fn default() -> Self {
        Self::new(RESULTS_KEPT)
    }
}

impl<V, K: Clone, M: OutcomeMap<K, V>, O: KeyOrder<K>> ResultCache<V, K, M, O> {
    pub fn new(cap: usize) -> Self {
        Self { cap, map: M::default(), order: O::default(), _entries: std::marker::PhantomData }
    }

    /// The outcome recorded for `cmd`, if it ran (and hasn't been evicted).
    pub fn get<Q: Ord + ?Sized>(&self, cmd: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.map.get(cmd)
    }

    /// Record `cmd`'s outcome. A key already present keeps its place (its value is replaced); a new
    /// one past the bound evicts the oldest.
    pub fn insert<Q: ToOwned<Owned = K> + ?Sized>(&mut self, cmd: &Q, outcome: V) {
        let key = cmd.to_owned();
        if self.map.insert(key.clone(), outcome).is_none() {
            self.order.push_back(key);
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
        let mut c: ResultCache<i32> = ResultCache::new(2);
        c.insert("a", 1);
        c.insert("b", 2);
        c.insert("a", 3); // replaced in place, still the oldest
        assert_eq!(c.get("a"), Some(&3));
        c.insert("c", 4);
        assert_eq!(c.get("a"), None, "the oldest key is evicted");
        assert_eq!((c.get("b"), c.get("c"), c.len()), (Some(&2), Some(&4), 2));
    }
}

/// Kani harnesses (`cargo kani -p nestd-core --harness results::proofs::<name>`).
#[cfg(kani)]
mod proofs {
    use std::borrow::Borrow;

    use super::{KeyOrder, OutcomeMap, ResultCache};

    /// Keys range over `0..KEYS`, values over every `u8`.
    const KEYS: u8 = 4;
    /// Inserts per run.
    const STEPS: usize = 6;

    /// A map indexed by the key itself (keys are below `KEYS`).
    #[derive(Default)]
    struct SlotMap([Option<u8>; KEYS as usize]);

    impl OutcomeMap<u8, u8> for SlotMap {
        fn get<Q: Ord + ?Sized>(&self, key: &Q) -> Option<&u8>
        where
            u8: Borrow<Q>,
        {
            (0..KEYS).find(|k| k.borrow() == key).and_then(|k| self.0[k as usize].as_ref())
        }

        fn insert(&mut self, key: u8, value: u8) -> Option<u8> {
            let old = self.0[key as usize];
            self.0[key as usize] = Some(value);
            old
        }

        fn remove(&mut self, key: &u8) {
            self.0[*key as usize] = None;
        }

        fn len(&self) -> usize {
            self.0.iter().filter(|v| v.is_some()).count()
        }
    }

    /// A FIFO in a fixed array, oldest first. Holds up to `KEYS` keys: the cache holds at most
    /// `cap + 1 <= KEYS` while it evicts.
    #[derive(Default)]
    struct SlotOrder {
        keys: [u8; KEYS as usize],
        len: usize,
    }

    impl KeyOrder<u8> for SlotOrder {
        fn push_back(&mut self, key: u8) {
            assert!(self.len < KEYS as usize, "the model FIFO is full");
            self.keys[self.len] = key;
            self.len += 1;
        }

        fn pop_front(&mut self) -> Option<u8> {
            if self.len == 0 {
                return None;
            }
            let first = self.keys[0];
            for i in 1..KEYS as usize {
                self.keys[i - 1] = self.keys[i];
            }
            self.len -= 1;
            Some(first)
        }

        fn len(&self) -> usize {
            self.len
        }
    }

    /// Bounded: a cap of 1 to 3, 6 inserts of any of 4 keys with any value, checked after every
    /// insert: the cache holds at most `cap` outcomes; its map and its order hold the same keys,
    /// none twice; a key never inserted has no outcome; a key's outcome is the latest inserted for
    /// it; and a key that entered the cache is still there while fewer than `cap` distinct other
    /// keys have been inserted since it entered (a re-insert keeps its age, so "entered" is the
    /// insert that found it absent). The key tracked is any of the 4.
    #[kani::proof]
    #[kani::unwind(7)]
    fn the_cache_is_bounded_and_keeps_recent_outcomes() {
        let cap: usize = kani::any_where(|c| (1..=3).contains(c));
        let mut c: ResultCache<u8, u8, SlotMap, SlotOrder> = ResultCache::new(cap);
        let k: u8 = kani::any_where(|k| *k < KEYS);
        let mut inserted = [false; KEYS as usize];
        let mut latest: Option<u8> = None;
        // Since `k` last entered the cache (`None`: it never has): the other keys inserted, as bits.
        let mut since: Option<u8> = None;
        for _ in 0..STEPS {
            let key: u8 = kani::any_where(|q| *q < KEYS);
            let value: u8 = kani::any();
            let entering = key == k && c.get(&k).is_none();
            c.insert(&key, value);
            inserted[key as usize] = true;
            if key == k {
                latest = Some(value);
                if entering {
                    since = Some(0);
                }
            } else if let Some(s) = since.as_mut() {
                *s |= 1 << key;
            }

            assert!(c.len() <= cap);
            assert!(c.order.len == c.map.len());
            for i in 0..KEYS as usize {
                if i < c.order.len {
                    let q = c.order.keys[i];
                    assert!(c.map.get(&q).is_some());
                    for j in i + 1..KEYS as usize {
                        assert!(j >= c.order.len || c.order.keys[j] != q);
                    }
                }
            }
            for q in 0..KEYS {
                if !inserted[q as usize] {
                    assert!(c.get(&q).is_none());
                }
            }
            if let Some(v) = c.get(&k) {
                assert!(Some(*v) == latest);
            }
            if since.is_some_and(|s| (s.count_ones() as usize) < cap) {
                assert!(c.get(&k).copied() == latest);
            }
        }
    }
}
