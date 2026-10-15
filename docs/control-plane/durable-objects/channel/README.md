# ChannelDO

The authority for one [channel](../../../channels/): its log, subscriptions and their cursors.

- **Storage:** message index and inline bodies in SQLite. Bodies over about 32 KB go to R2 (`channels/<channel>/<seq>`). Retention is enforced by an alarm.
- **Post:**
  1. Check the poster's grant (AgentDO already checked it; ChannelDO checks the channel's own grant list again).
  2. Assign `seq`, store, update the keyed index.
  3. Set the alarm and return. **Fan-out never runs in the post path,** so one slow subscriber can't stall a post or keep the channel billed.
- **Fan-out runs from the alarm:** `AgentDO.deliver(channel, messages)` per matching subscription, with bounded parallelism, RPC timeouts and per-subscriber backoff. It's at least once and in order per subscription: a cursor advances only after its AgentDO acks. Past about 100 subscribers, a channel would shard its fan-out (or use Queues).
- **Guards:** idempotency keys, dropped repeats and per-poster rate limits are applied before `seq` is assigned. See [limits](../../../channels/#limits-and-loop-guards).
- **Subscriptions live here** (filter, delivery, batch window, `once`, cursor). AgentDO keeps only the list of its own subscriptions, for display and cleanup.
- **Batching:** a subscription with `batch_ms` is flushed by the alarm.
- **Replies:** an `await_reply_s` wait is held in the poster's AgentDO call and backed by a `once` subscription. An eviction loses only the synchronous wait, never the reply.
- **Built-in channels** (`<agt>/inbox`, `<agt>/events`, `<sbx>/events`, `user`) are ordinary ChannelDOs, created with the agent or sandbox and owned by it.
- **Cost:** idle channels hold no WebSocket and no alarm, so they cost only storage.

**Not built.**
