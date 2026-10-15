# Channels

A channel is a named, durable, append-only log of messages. Agents, programs in sandboxes (through the `nest` CLI), the platform and I post to channels, read them and subscribe to them. **It's the only coordination primitive:** inboxes, platform events, questions, shared state and memory are all channels.

**Why one primitive:** messages, events, questions, waits and memory are all "append something somewhere and wake whoever cares." One log with subscriptions covers them all, and leaves the structure to the agents. The same shape shows up in Anthropic's [Managed Agents](https://anthropic.com/engineering/managed-agents) (a durable log outside the context window, read in slices; 2026-04) and in blackboard systems, which beat master–worker designs in [one 2025 study](https://arxiv.org/abs/2510.01285).

## Messages

```
{seq, ts_ms, from, taint, kind?, text, data?, reply_to?, key?, mentions?[]}
```

- **`seq`** is per channel, dense and ordered. Readers page with `since`.
- **`from` and `taint` are set by the platform,** never by the sender and never parsed from content. `from` is `agt_…`, `user` (me), `platform`, or `sbx_…` with the attributed agent. `taint` is the sender session's taint (see [grants and taint](../agents/tools/#taint-and-sinks)); posts from programs in a sandbox are always tainted. Labels taken from content can be forged ([FIDES label forgery, 2026-09](https://labs.apisec.ai/research/articles/trust-me-bro-forging-security-labels-fides)).
- **`kind`** is a free-form label (`progress`, `question`, `blocked`, `pr_opened`, …). The platform's own kinds are listed under [built-in channels](#built-in-channels); every other kind is a convention between agents.
- **`reply_to`** threads a message under another. Questions are answered by replying.
- **Size:** text plus data up to about 32 KB inline. Bigger bodies go to R2, and the message carries a reference.

## Keys

Keyed messages form a key-value view: shared state (a spec, a task board, claims on work) and **memory** (an agent's private channel), without a second primitive.
- `read(latest_by_key, prefix?, keys_only?)` returns the newest message per key.
- `post(key, if_seq?)` is a compare-and-set: it fails if the key's newest `seq` isn't `if_seq`. Two agents claiming the same task can't both win.
- A keyed post with no text removes the key from the view.

## Built-in channels

| Channel | Posted by | Contents |
|---|---|---|
| `<agt_…>/inbox` | Whoever holds `post` on it: its owner, and peers through the [messaging capability](../agents/capabilities/#messaging) (by default, agents sharing its group label) | Messages to the agent. The agent is always subscribed. The platform also posts its background task exits here. |
| `<agt_…>/events` | Platform | State changes, escalations, and `turn_completed` / `exit` carrying the final text (up to 2 KB) and usage. **The spawner is subscribed by default,** so results come back without being asked for. |
| `<sbx_…>/events` | Platform | State changes, ports opened and exposed, egress denials and alerts, orphaned work, rollback notices |
| `user` | Whoever holds `post` on it | Messages to me. The [Discord bot](../control-plane/api/discord/) bridges it. |

Agents create any other channel (`ws/auth`, `team/review`). Names are hierarchical for tidiness only; they carry no meaning.

## Subscriptions

`subscribe(channel, filter?, delivery, batch_ms?, once?)` registers a wake rule for an agent:
- **Filter:** `kinds`, `from`, `mentions_me`, `reply_to`. An empty filter matches everything.
- **Delivery:**
  - `turn`: when the agent is idle, matches start its next turn; mid-turn, a notice joins the inbox stream (stdin, or the `Stop` hook).
  - `none`: only a cursor, for later reads.
- **`batch_ms`** coalesces matches into one turn, so a burst of events costs one wake.
- **`once`** ends the subscription at the first match. Replies use it.
- **Waking a brain** that isn't running starts one. See [AgentDO](../control-plane/durable-objects/agent/).

An agent subscribes itself, or its spawner subscribes it as part of the spawn spec.

## The wake envelope

A woken turn's input is a **platform notice, not the messages**: per subscription, the channel, `seq` range, count, senders, kinds and taint, plus the wall-clock time, the time since the agent's last turn, and its remaining budget. **Message bodies reach the model only as `read` results** (tool output).

- **Why:** the user role is where a principal gives instructions. Claude treats tool results as information rather than commands ([Claude's constitution](https://www.anthropic.com/constitution)), while naming the sender inside a user message is only a prompt heuristic ([spotlighting](https://arxiv.org/abs/2403.14720)). Injections also spread from agent to agent ([Prompt Infection](https://arxiv.org/abs/2410.07283)).
- **Messages from me** (`user`) are the exception: they arrive inline, as user messages.
- **Cost:** one extra tool call per wake. The notice is small, so it needs no digest step.

## Asking

`post(channel, text, await_reply_s?)` with `await_reply_s` (at most about 120 s) waits for the first reply. If none comes, it returns `pending`, and a `once` subscription delivers the reply as a later turn. Escalations use the same path:
- A `PreToolUse` call that matches no rule, a sink call from a tainted session, or an egress denial posts a `question` to the agent's **escalation channel** (set in its spawn spec; by default its spawner's inbox, or `user` for agents I spawn).
- A reply that approves a grant or a sink call counts only if the replier holds that grant and its own session is untainted.

## Limits and loop guards

- **An agent's own posts never wake it.**
- **Repeats are dropped:** a sender's message identical to its previous one on the same channel (same text and data) within a minute isn't stored.
- **Rate limits** per poster per channel, and a per-agent cap of **60 subscription-started turns an hour**. A loop (A wakes B wakes A) hits a wall, not a bill.
- **Bounded backlog:** at most 50 deliveries wait per agent; the oldest is dropped with a notice. Claude Code's own cross-session messaging uses the same guards ([docs](https://code.claude.com/docs/en/cross-session-messaging)).
- **Idempotent posts:** `post(idem_key?)` returns the existing `seq` for a repeated key, so a retried post after an eviction lands once.
- **Retention:** set per channel. The default is 30 days; a keyed message is kept while it's the newest for its key.
- **Tiering:** message bodies older than 7 days move to R2. The index and the keyed view stay in SQLite, and reads fetch old bodies transparently, so a channel's DO storage stays bounded however long it lives.
- **Delivery:** at least once, in order per subscription. AgentDO deduplicates with a per-subscription high-water `seq`.
- **Posting** needs `post` on the channel and **reading** needs `read`; a channel's owner holds both and can grant them.

**No interop for now:** [A2A](https://a2a-protocol.org/latest/specification/) is client-to-server tasks with no pub/sub, and [MCP tasks](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) have no agent-to-agent features. Either could be an adapter at the edge later.

These are starting defaults ("balanced"), tuned from experience.

**Implementation:** one [ChannelDO](../control-plane/durable-objects/channel/) per channel. Not built yet.
