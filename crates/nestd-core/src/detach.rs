//! Agent detaches a sandbox's guest hasn't confirmed yet (audit G-B2, G-B3).
//!
//! `agent_detach{kill_processes}` must reach the guest agent: only it can stop the agent's tasks
//! and kill its processes. SandboxDO sends the command once and never retries it, so nestd owns its
//! delivery. A detach is **owed** from the moment it is asked until the guest confirms it:
//! - while it is owed, the guest connection keeps the agent's slot in every `configure` it sends,
//!   so a reconnect never drops the agent from the guest's table (which would orphan its processes
//!   where the guest has no cgroup to find them by) before the detach arrives;
//! - the connection sends every owed detach after each `configure` (before the guest counts as
//!   ready) and every 10 s while one is owed; an `agent_detach` asked again, and an attach of the
//!   same agent, send it first;
//! - a kill, once asked, stays asked until a detach carrying it is confirmed.
//!
//! Each ask gets a number, and only a confirmation of the newest ask's detach settles it: a late
//! confirmation of an older send never settles a newer ask.
//!
//! A data structure, not a stepped machine: the guest connection (`nestd/src/guest.rs`) sends, and
//! orders sends against `configure`; this decides what is owed and when a confirmation settles it.

use alloc::collections::BTreeMap;

/// One owed detach: the number of the ask that last changed it, and whether it must kill.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Owed {
    pub ask: u64,
    pub kill: bool,
}

/// Detaches owed to one guest, by agent.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Detaches<K: Ord> {
    owed: BTreeMap<K, Owed>,
    next_ask: u64,
}

impl<K: Ord + Clone> Default for Detaches<K> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: Ord + Clone> Detaches<K> {
    pub fn new() -> Self {
        Detaches { owed: BTreeMap::new(), next_ask: 1 }
    }

    /// A detach of `agent` was asked. A kill asked by any of its askings is kept. Returns what a
    /// detach sent for it now must carry.
    pub fn ask(&mut self, agent: K, kill: bool) -> Owed {
        let ask = self.next_ask;
        self.next_ask += 1;
        let o = self.owed.entry(agent).or_insert(Owed { ask, kill });
        *o = Owed { ask, kill: o.kill || kill };
        *o
    }

    /// What a detach of `agent` sent now must carry, while one is owed.
    pub fn owed(&self, agent: &K) -> Option<Owed> {
        self.owed.get(agent).copied()
    }

    /// The guest confirmed the detach sent for `sent`. True when that settles what is owed, and
    /// the agent's slot may leave the `configure` set: `sent` is still the newest ask. False when
    /// nothing is owed (another confirmation first), or an ask came since (it is still owed).
    pub fn confirmed(&mut self, agent: &K, sent: Owed) -> bool {
        if self.owed.get(agent) == Some(&sent) {
            self.owed.remove(agent);
            true
        } else {
            false
        }
    }

    /// Every owed detach, by agent: what the connection sends after a `configure`.
    pub fn all(&self) -> impl Iterator<Item = (&K, Owed)> {
        self.owed.iter().map(|(k, &o)| (k, o))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn owed(d: &Detaches<&'static str>) -> Vec<(&'static str, bool)> {
        d.all().map(|(k, o)| (*k, o.kill)).collect()
    }

    #[test]
    fn a_detach_is_owed_until_the_guest_confirms_it() {
        let mut d = Detaches::new();
        assert_eq!(d.owed(&"a"), None);
        let sent = d.ask("a", true);
        assert_eq!(d.owed(&"a"), Some(sent));
        assert!(sent.kill);
        assert_eq!(owed(&d), [("a", true)]);
        assert!(d.confirmed(&"a", sent), "a confirmed detach settles it");
        assert_eq!(d.owed(&"a"), None);
        assert!(owed(&d).is_empty());
        assert!(!d.confirmed(&"a", sent), "a second confirmation settles nothing: the slot is already gone");
    }

    #[test]
    fn a_kill_once_asked_stays_asked() {
        let mut d = Detaches::new();
        d.ask("a", true);
        assert!(d.ask("a", false).kill, "a later detach without a kill doesn't cancel the kill");
        let mut d = Detaches::new();
        d.ask("a", false);
        assert!(d.ask("a", true).kill);
    }

    #[test]
    fn only_a_confirmation_of_the_newest_ask_settles_it() {
        let mut d = Detaches::new();
        let first = d.ask("a", false);
        // Asked again (with a kill) before the first send's confirmation came back.
        let second = d.ask("a", true);
        assert_ne!(first.ask, second.ask);
        assert!(!d.confirmed(&"a", first), "a late confirmation of an older send settles nothing");
        assert_eq!(d.owed(&"a"), Some(second));
        // The same ask again, without a kill: still a newer ask than the one sent.
        let third = d.ask("a", false);
        assert!(third.kill);
        assert!(!d.confirmed(&"a", second));
        assert!(d.confirmed(&"a", third));
    }

    #[test]
    fn agents_are_owed_apart() {
        let mut d = Detaches::new();
        let a = d.ask("a", true);
        d.ask("b", false);
        assert!(d.confirmed(&"a", a));
        assert_eq!(owed(&d), [("b", false)], "other agents are untouched");
    }
}
