//! Agent detaches a sandbox's guest hasn't confirmed yet (audit G-B2, G-B3).
//!
//! `agent_detach{kill_processes}` must reach the guest agent: only it can stop the agent's tasks
//! and kill its processes. SandboxDO sends the command once and never retries it, so nestd owns its
//! delivery. A detach is **owed** from the moment it is asked until the guest confirms it:
//! - while it is owed, the guest connection keeps the agent's slot in every `configure` it sends,
//!   so a reconnect never drops the agent from the guest's table (which would orphan its processes
//!   where the guest has no cgroup to find them by) before the detach arrives;
//! - after each `configure` the connection sends every detach still owed, and nestd's `agent_detach`
//!   sends one again when it is asked twice (the host's own slot already gone);
//! - a kill, once asked, stays asked until a detach with a kill is confirmed;
//! - an attach of the same agent ends what is owed: the newer attachment must not be killed.
//!
//! The shell (`nestd/src/guest.rs`) performs the sends; this decides what is owed and when a
//! confirmation lets the slot go.

use alloc::collections::BTreeMap;

/// Detaches owed to one guest, by agent: whether each must kill the agent's processes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Detaches<K: Ord> {
    owed: BTreeMap<K, bool>,
}

impl<K: Ord + Clone> Detaches<K> {
    pub fn new() -> Self {
        Detaches { owed: BTreeMap::new() }
    }

    /// A detach of `agent` was asked. A kill asked by any of its askings is kept.
    pub fn ask(&mut self, agent: K, kill: bool) {
        let k = self.owed.entry(agent).or_insert(false);
        *k = *k || kill;
    }

    /// `agent` was attached (again): any detach owed for it is moot.
    pub fn attached(&mut self, agent: &K) {
        self.owed.remove(agent);
    }

    /// What a detach of `agent` sent now must carry: `Some(kill)` while one is owed.
    pub fn owed(&self, agent: &K) -> Option<bool> {
        self.owed.get(agent).copied()
    }

    /// The guest confirmed a detach of `agent` sent with `kill`. True when that settles what is
    /// owed, and the agent's slot may leave the `configure` set: one was owed, and the confirmed
    /// detach killed if a kill was asked. False when nothing is owed (an attach since, or another
    /// confirmation first), or a kill was asked after a detach without one went out.
    pub fn confirmed(&mut self, agent: &K, kill: bool) -> bool {
        match self.owed.get(agent) {
            Some(&asked) if kill || !asked => {
                self.owed.remove(agent);
                true
            }
            _ => false,
        }
    }

    /// Every owed detach, by agent: what the connection sends after a `configure`.
    pub fn all(&self) -> impl Iterator<Item = (&K, bool)> {
        self.owed.iter().map(|(k, &kill)| (k, kill))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn owed(d: &Detaches<&'static str>) -> Vec<(&'static str, bool)> {
        d.all().map(|(k, kill)| (*k, kill)).collect()
    }

    #[test]
    fn a_detach_is_owed_until_the_guest_confirms_it() {
        let mut d = Detaches::new();
        assert_eq!(d.owed(&"a"), None);
        d.ask("a", true);
        assert_eq!(d.owed(&"a"), Some(true));
        assert_eq!(owed(&d), [("a", true)]);
        assert!(d.confirmed(&"a", true), "a confirmed kill settles it");
        assert_eq!(d.owed(&"a"), None);
        assert!(owed(&d).is_empty());
        assert!(!d.confirmed(&"a", true), "a second confirmation settles nothing: the slot is already gone");
    }

    #[test]
    fn a_kill_once_asked_stays_asked() {
        let mut d = Detaches::new();
        d.ask("a", true);
        d.ask("a", false);
        assert_eq!(d.owed(&"a"), Some(true), "a later detach without a kill doesn't cancel the kill");
        let mut d = Detaches::new();
        d.ask("a", false);
        d.ask("a", true);
        assert_eq!(d.owed(&"a"), Some(true));
    }

    #[test]
    fn a_detach_without_a_kill_doesnt_settle_a_kill_asked_since() {
        let mut d = Detaches::new();
        d.ask("a", false);
        // A detach without a kill went out; a kill was asked before its confirmation came back.
        d.ask("a", true);
        assert!(!d.confirmed(&"a", false), "the kill is still owed");
        assert_eq!(d.owed(&"a"), Some(true));
        assert!(d.confirmed(&"a", true));
    }

    #[test]
    fn a_detach_without_a_kill_is_settled_by_either_confirmation() {
        let mut d = Detaches::new();
        d.ask("a", false);
        assert!(d.confirmed(&"a", false));
        let mut d = Detaches::new();
        d.ask("a", false);
        assert!(d.confirmed(&"a", true), "a detach that killed did more than asked");
    }

    #[test]
    fn an_attach_ends_what_is_owed_and_a_late_confirmation_keeps_the_slot() {
        let mut d = Detaches::new();
        d.ask("a", true);
        d.ask("b", false);
        d.attached(&"a");
        assert_eq!(d.owed(&"a"), None, "the newer attachment is never killed");
        assert_eq!(owed(&d), [("b", false)], "other agents are untouched");
        // The detach sent before the attach is confirmed after it: the slot is the new attachment's.
        assert!(!d.confirmed(&"a", true));
    }
}
