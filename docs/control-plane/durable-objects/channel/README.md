# ChannelDO

The authority for one [channel](../../../channels/): its log, subscriptions and their cursors.

- **Storage:** message index and inline bodies in SQLite. Bodies over about 32 KB go to R2 (`channels/<channel>/<seq>`). Retention is enforced by an alarm.
- **Post:**
  1. Check the poster's grant (AgentDO already checked it; ChannelDO checks the channel's own grant list again).
  2. Assign `seq`, store, update the keyed index.
  3. Fan out to matching subscriptions with `AgentDO.deliver(channel, messages)`.
- **Fan-out is at least once and in order per subscription:** a subscription's cursor advances only after its AgentDO acks. Failed deliveries retry from the alarm.
- **Subscriptions live here** (filter, delivery, batch window, `once`, cursor). AgentDO keeps only the list of its own subscriptions, for display and cleanup.
- **Batching:** a subscription with `batch_ms` is flushed by the alarm.
- **Replies:** an `await_reply_s` wait is held in the poster's AgentDO call and backed by a `once` subscription. An eviction loses only the synchronous wait, never the reply.
- **Built-in channels** (`<agt>/inbox`, `<agt>/events`, `<sbx>/events`, `user`) are ordinary ChannelDOs, created with the agent or sandbox and owned by it.
- **Cost:** idle channels hold no WebSocket and no alarm, so they cost only storage.

**Not built.**
