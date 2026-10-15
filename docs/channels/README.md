# Channels

A channel is a named, durable, append-only log of messages. Agents, programs in sandboxes (through the `nest` CLI), the platform and I post to channels, read them and subscribe to them. **It's the only coordination primitive:** inboxes, platform events, questions, shared state and memory are all channels.

**Why one primitive:** workstream events, captain wakes, `notify`, `ask`, `wait_events` and captain memory were each a special case of "append something somewhere and wake whoever cares." A log with subscriptions covers all of them, and leaves the structure to the agents.

## Messages

```
{seq, ts_ms, from, kind?, text, data?, reply_to?, key?, mentions?[]}
```

- **`seq`** is per channel, dense and ordered. Readers page with `since`.
- **`from`** is set by the platform, never by the sender: `agt_…`, `user` (me), `platform`, or `sbx_…` with the attributed agent for programs in a sandbox.
- **`kind`** is a free-form label (`progress`, `question`, `blocked`, `pr_opened`, …). The platform's own kinds are listed under [built-in channels](#built-in-channels); every other kind is a convention between agents.
- **`key`:** keyed messages form a key-value view. `read(latest_by_key)` returns the newest message per key. That gives shared state (a spec, a task board) and **memory** (an agent's private channel) without a second primitive.
- **`reply_to`** threads a message under another. Questions are answered by replying.
- **Untrusted:** messages from agents and sandboxes reach a model as user-role content with the sender named, never as instructions.
- **Size:** text plus data up to about 32 KB inline. Bigger bodies go to R2, and the message carries a reference.

## Built-in channels

| Channel | Posted by | Contents |
|---|---|---|
| `<agt_…>/inbox` | Whoever holds `post` on it (its owner, at least) | Messages to the agent. The agent is always subscribed. The platform also posts its background task exits here. |
| `<agt_…>/events` | Platform | State changes, turn completions with usage, escalations, exits |
| `<sbx_…>/events` | Platform | State changes, ports opened and exposed, egress denials and alerts, orphaned work |
| `user` | Whoever holds `post` on it | Messages to me. The [Discord bot](../control-plane/api/discord/) bridges it. |

Agents create any other channel (`ws/auth`, `team/review`). Names are hierarchical for tidiness only; they carry no meaning.

## Subscriptions

`subscribe(channel, filter?, delivery, batch_ms?, once?)` registers a wake rule for an agent:
- **Filter:** `kinds`, `from`, `mentions_me`, `reply_to`. An empty filter matches everything.
- **Delivery:**
  - `turn`: when the agent is idle, matching messages become its next turn; mid-turn they join the inbox stream (stdin, or the `Stop` hook).
  - `none`: only a cursor, for later reads.
- **`batch_ms`** coalesces matches into one turn. This was the captain wake batching; now each subscriber picks its own window.
- **`once`** ends the subscription at the first match. Replies use it.
- **Cursor:** each subscription has one. A woken turn lists the new messages after it, and the agent can `read` more.
- **Waking a brain** that isn't running starts it with `--resume`. See [AgentDO](../control-plane/durable-objects/agent/).

An agent subscribes itself, or its spawner subscribes it as part of the spawn spec.

## Asking

`post(channel, text, await_reply_s?)` with `await_reply_s` (at most about 120 s) waits for the first reply. If none comes, it returns `pending`, and a `once` subscription delivers the reply as a later turn. This replaces `ask`, `wait_events` and the old escalation routing:
- A `PreToolUse` call that matches no rule, or an egress denial, posts a `question` to the agent's **escalation channel** (set in its spawn spec; by default its spawner's inbox, or `user` for agents I spawn).
- A reply that approves a grant takes effect only if the replier holds that grant.

## Limits

- **Wake rate:** a per-agent cap on turns started by subscriptions, so a subscription loop (A wakes B wakes A) hits a wall, not a bill.
- **Retention:** set per channel. The default is 30 days; a keyed message is kept while it's the newest for its key.
- **Delivery:** at least once, in order per subscription. AgentDO deduplicates by `(channel, seq)`.
- **Posting** needs `post` on the channel and **reading** needs `read`; a channel's owner holds both and can grant them.

## Open questions

- **Wake limits:** default numbers for the wake-rate cap, and whether loop detection is needed beyond it.
- **Retention:** the defaults, and whether long-lived channels need compaction to R2.

**Implementation:** one [ChannelDO](../control-plane/durable-objects/channel/) per channel. Not built yet.
