//! The inbox mirror's delivery side: which of AgentDO's mirrored inbox messages the model has
//! been handed, by the hooks alone. No I/O; it lives in [`crate::runtime::AgentInner`], so one
//! lock covers the decision and the marking, and two hooks never hand out one message twice.
//!
//! - At a tool boundary (`PostToolUse`), every pending message goes out as `additionalContext`.
//!   UNVERIFIED that Claude Code shows it to the model mid-turn under `-p` stream-json for
//!   `mcp__nest__*` tools; if it doesn't, such a message is confirmed but never seen (`Stop`
//!   doesn't offer it again). `Config::inbox_at_tool_boundary` turns this off, leaving only `Stop`.
//! - At `Stop`, every pending message goes out as `decision: block`, up to
//!   `max_stop_continuations` per stop chain.
//! - Only while a turn takes inbox ([`crate::brain::Brain::takes_inbox`]). A message the running
//!   turn never handed out stays unconfirmed, and AgentDO queues it again when the turn completes.

use std::collections::HashSet;

use nest_protocol::control::{AgentCache, InboxMessage};
use nest_protocol::model::MessageId;

#[derive(Debug, Default)]
pub struct InboxMirror {
    /// Set by the actor from the brain: a turn runs and takes inbox.
    open: bool,
    delivered: HashSet<MessageId>,
    stop_continuations: u32,
}

impl InboxMirror {
    pub fn set_open(&mut self, open: bool) {
        if open && !self.open {
            self.stop_continuations = 0;
        }
        self.open = open;
    }

    /// `PostToolUse`: everything pending, marked delivered.
    pub fn take_at_tool_boundary(&mut self, cache: Option<&AgentCache>) -> Vec<InboxMessage> {
        if !self.open {
            return Vec::new();
        }
        self.take(cache)
    }

    /// `Stop`: everything pending, marked delivered, unless this stop chain used up its
    /// continuations. `stop_hook_active: false` starts a new chain (a stop we didn't cause).
    pub fn take_at_stop(&mut self, cache: Option<&AgentCache>, stop_hook_active: bool) -> Vec<InboxMessage> {
        if !stop_hook_active {
            self.stop_continuations = 0;
        }
        let max = cache.map(|c| c.max_stop_continuations).unwrap_or(0);
        if !self.open || self.stop_continuations >= max {
            return Vec::new();
        }
        let out = self.take(cache);
        if !out.is_empty() {
            self.stop_continuations += 1;
        }
        out
    }

    /// The hook's answer never reached Claude Code: those messages are pending again.
    pub fn release(&mut self, ids: &[MessageId]) {
        for id in ids {
            self.delivered.remove(id);
        }
    }

    /// Never an `interrupt` message: it cuts the running turn short and is AgentDO's to queue as
    /// the next one, which a hook racing the actor's interrupt must not pre-empt.
    fn take(&mut self, cache: Option<&AgentCache>) -> Vec<InboxMessage> {
        let pending: Vec<InboxMessage> = cache
            .into_iter()
            .flat_map(|c| &c.inbox)
            .filter(|m| !m.interrupt && !self.delivered.contains(&m.id))
            .cloned()
            .collect();
        self.delivered.extend(pending.iter().map(|m| m.id.clone()));
        pending
    }
}

/// The text the model reads.
pub fn render(messages: &[InboxMessage]) -> String {
    let mut text = String::from("New messages arrived while you were working:\n");
    for m in messages {
        text.push_str(&format!("\n[message from {}]\n{}\n", m.from, m.text));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache(ids: &[&str]) -> AgentCache {
        let inbox = ids
            .iter()
            .map(|id| InboxMessage { id: MessageId(id.to_string()), from: "user".into(), text: format!("hello {id}"), interrupt: false, ts_ms: 0 })
            .collect();
        AgentCache { version: 1, rules: vec![], inbox, max_stop_continuations: 1 }
    }

    fn ids(m: &[InboxMessage]) -> Vec<&str> {
        m.iter().map(|m| m.id.0.as_str()).collect()
    }

    /// R4: one message is handed out once, whichever hook asks first.
    #[test]
    fn each_message_goes_out_once_across_tool_boundaries_and_stop() {
        let mut m = InboxMirror::default();
        m.set_open(true);
        let c = cache(&["m1"]);
        assert_eq!(ids(&m.take_at_tool_boundary(Some(&c))), ["m1"]);
        assert!(m.take_at_tool_boundary(Some(&c)).is_empty());
        assert!(m.take_at_stop(Some(&c), false).is_empty());
        let c = cache(&["m1", "m2"]);
        assert_eq!(ids(&m.take_at_stop(Some(&c), false)), ["m2"]);
    }

    #[test]
    fn nothing_goes_out_while_closed_and_a_release_makes_a_message_pending_again() {
        let mut m = InboxMirror::default();
        let c = cache(&["m1"]);
        assert!(m.take_at_tool_boundary(Some(&c)).is_empty(), "no turn takes inbox");
        assert!(m.take_at_stop(Some(&c), false).is_empty());
        m.set_open(true);
        let out = m.take_at_tool_boundary(Some(&c));
        m.release(&out.iter().map(|m| m.id.clone()).collect::<Vec<_>>());
        assert_eq!(ids(&m.take_at_stop(Some(&c), false)), ["m1"]);
    }

    /// An `interrupt` message ends the turn it arrives in, and comes back from AgentDO as the next
    /// one. Handed out by a hook that ran before the actor saw the interrupt (the cache update
    /// lands first), it would be consumed by the turn being cut short.
    #[test]
    fn an_interrupting_message_is_never_handed_out() {
        let mut m = InboxMirror::default();
        m.set_open(true);
        let mut c = cache(&["m1", "m2"]);
        c.inbox[0].interrupt = true;
        assert_eq!(ids(&m.take_at_tool_boundary(Some(&c))), ["m2"]);
        assert!(m.take_at_stop(Some(&c), false).is_empty());
    }

    #[test]
    fn stop_continuations_are_bounded_per_chain_and_per_turn() {
        let mut m = InboxMirror::default();
        m.set_open(true);
        assert_eq!(ids(&m.take_at_stop(Some(&cache(&["m1"])), false)), ["m1"]);
        assert!(m.take_at_stop(Some(&cache(&["m1", "m2"])), true).is_empty(), "max 1 per chain");
        // A stop we didn't cause starts a new chain.
        assert_eq!(ids(&m.take_at_stop(Some(&cache(&["m1", "m2"])), false)), ["m2"]);
        assert!(m.take_at_stop(Some(&cache(&["m1", "m2", "m3"])), true).is_empty());
        // So does a new turn.
        m.set_open(false);
        m.set_open(true);
        assert_eq!(ids(&m.take_at_stop(Some(&cache(&["m1", "m2", "m3"])), true)), ["m3"]);
        // Tool boundaries have no bound.
        assert_eq!(ids(&m.take_at_tool_boundary(Some(&cache(&["m4"])))), ["m4"]);
    }
}
