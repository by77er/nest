# Channels

A channel is a named, durable, append-only log of messages. Agents, programs in sandboxes (through the `nest` CLI), the platform and I post to channels, read them and subscribe to them. **It's the only coordination primitive:** inboxes, platform events, questions, shared state and memory are all channels.

**Why one primitive:** messages, events, questions, waits and memory are all "append something somewhere and wake whoever cares." One log with subscriptions covers them all, and leaves the structure to the agents. The same shape shows up in Anthropic's [Managed Agents](https://anthropic.com/engineering/managed-agents) (a durable log outside the context window, read in slices; 2026-04) and in blackboard systems, which beat master–worker designs in [one 2025 study](https://arxiv.org/abs/2510.01285).

## Messages

```
{seq, ts_ms, from, taint, kind?, text, data?, reply_to?, key?, mentions?[]}
```

- **`seq`** is per channel, dense and ordered. Readers page with `since`.
- **`from` and `taint` are set by the platform,** never by the sender and never parsed from content. `from` is `agt_…`, `user` (me), `platform`, `hook:<hk_…>` for [external sources](sources/), or `sbx_…` with the attributed agent (hook and sandbox posts aren't built yet). `taint` is the sender session's taint (see [grants and taint](../agents/tools/#taint-and-sinks)); posts from programs in a sandbox are always tainted. Labels taken from content can be forged ([FIDES label forgery, 2026-09](https://labs.apisec.ai/research/articles/trust-me-bro-forging-security-labels-fides)).
- **`kind`** is a free-form label (`progress`, `question`, `blocked`, `pr_opened`, …). The platform's own kinds are listed under [built-in channels](#built-in-channels); every other kind is a convention between agents.
- **`reply_to`** threads a message under another. Questions are answered by replying.
- **Size:** text plus data up to 32 KiB inline. Bigger bodies (up to 1 MiB) go to R2, and the message carries a reference.

## Keys

Keyed messages form a key-value view: shared state (a spec, a task board, claims on work) and **memory** (an agent's private channel), without a second primitive.
- `read(latest_by_key, prefix?, keys_only?)` returns the newest message per key.
- `post(key, if_seq?)` is a compare-and-set: it fails if the key's newest `seq` isn't `if_seq`. Two agents claiming the same task can't both win.
- A keyed post with no text removes the key from the view.
- **Keys are short identifiers** (`[a-z0-9/_.-]`, at most 64 characters), so a key index can't carry instructions; the index marks keys whose newest entry is tainted.

## Built-in channels

| Channel | Posted by | Contents |
|---|---|---|
| `<agt_…>/inbox` | Whoever holds `post` on it: its owner, and peers through the [messaging capability](../agents/capabilities/#messaging) (by default, agents sharing its group label, once labels exist; built today: `messaging-tree`, its owner and the agents it owns) | Messages to the agent. The agent is always subscribed. The platform will also post its background task exits here (not built: they go to a working brain's inbox directly). |
| `<agt_…>/events` | Platform | State changes, escalations, `turn_completed` with the turn's final text (up to 2 KB) and usage, `exited` when the agent stops (with the last text), and `brain_released` for a brain that ends without the agent stopping (idle, a move, a host's loss). **The spawner is subscribed by default** (to `turn_completed` and `exited`) when it can `read`, so results come back without being asked for. |
| `<sbx_…>/events` | Platform | State changes, placements (`moved`), ports exposed and unexposed, destruction; egress denials and alerts, orphaned work and rollback notices once they are reported |
| `user` | Whoever holds `post` on it | Messages to me, read only by me (and by an agent I grant it by its exact name). The [Discord bot](../control-plane/api/discord/) bridges it; until it exists, the operator API reads it. |

Agents create any other channel (`ws/auth`, `team/review`). Names are hierarchical for tidiness only; they carry no meaning.

## Subscriptions

`subscribe(channel, filter?, delivery, batch_ms?, once?)` registers a wake rule for an agent. Subscribing needs `read` (a wake names senders and kinds):
- **Filter:** `kinds`, `from`, `keys` (key prefixes, e.g. a hook's `ref/<branch>`), `mentions_me`, `reply_to`. An empty filter matches everything.
- **Delivery:**
  - `turn`: when the agent is idle, matches start its next turn; mid-turn, a notice joins the inbox stream (stdin, or the `Stop` hook).
  - `none`: only a cursor: a `read` without `since` starts there and moves it.
- **`batch_ms`** coalesces matches into one turn, so a burst of events costs one wake.
- **`once`** ends the subscription at the first match. Replies use it.
- **Waking a brain** that isn't running starts one. See [AgentDO](../control-plane/durable-objects/agent/).

An agent subscribes itself; its spawner will subscribe it as part of the spawn spec once `agent_spawn` exists (until then the operator API can).

## The wake envelope

A woken turn's input is a **platform notice, not the messages**: per subscription, the channel, `seq` range, count, senders, kinds and taint, plus the wall-clock time, the time since the agent's last turn, and its remaining budget. **Message bodies reach the model only as `read` results** (tool output).

- **Why:** the user role is where a principal gives instructions. Claude treats tool results as information rather than commands ([Claude's constitution](https://www.anthropic.com/constitution)), while naming the sender inside a user message is only a prompt heuristic ([spotlighting](https://arxiv.org/abs/2403.14720)). Injections also spread from agent to agent ([Prompt Infection](https://arxiv.org/abs/2410.07283)).
- **Messages from me** (`user`) are the exception: they arrive inline, as user messages.
- **Cost:** one extra tool call per wake. The notice is small, so it needs no digest step.

## Asking

**Not built yet:** this section is the design. Today `ask` and approvals go through AgentDO's asks and the interim [workstream channel](../orchestration/workstreams/#the-interim-workstream-channel); moving them here is the next stage.

`post(channel, text, await_reply_s?)` with `await_reply_s` (at most about 120 s) waits for the first reply. If none comes, it returns `pending`, and a `once` subscription delivers the reply as a later turn. Escalations use the same path:
- A `PreToolUse` call that matches no rule, or a sink call from a tainted session, posts a `question` to the agent's **escalation channel** (set in its spawn spec; by default its spawner's inbox, or `user` for agents I spawn). After an egress denial, the agent asks the same way.
- A reply that approves a grant or a sink call counts only if the replier holds that grant and its own session is untainted.

## Limits and loop guards

- **An agent's own posts never wake it.**
- **Repeats are dropped:** a sender's message identical to its previous one on the same channel (same text, data, kind and key) within a minute isn't stored.
- **Rate limits:** 120 posts a minute per poster per channel (not for me or the platform), and a per-agent cap of **60 subscription-started or scheduled turns an hour**. A loop (A wakes B wakes A) hits a wall, not a bill.
- **Bounded backlog:** at most 50 subscription-started turns wait per agent. A delivery past either cap is deferred, not dropped: the channel keeps the messages, and the next delivery covers them in one wake. Claude Code's own cross-session messaging uses the same guards ([docs](https://code.claude.com/docs/en/cross-session-messaging)).
- **Idempotent posts:** `post(idem_key?)` returns the existing `seq` for a repeated key, so a retried post after an eviction lands once.
- **Retention:** set per channel. The default is 30 days; a keyed message is kept while it's the newest for its key.
- **Tiering:** message bodies older than 7 days move to R2. The index and the keyed view stay in SQLite, and reads fetch old bodies transparently, so old bodies leave a channel's DO storage however long it lives (its index rows, keys and subscriptions still grow: see [garbage collection](../control-plane/durable-objects/channel/)).
- **Delivery:** at least once, in order per subscription. AgentDO deduplicates with a per-subscription high-water `seq`.
- **Posting** needs `post` on the channel and **reading** needs `read`; a channel's owner holds both and can grant them. An agent always holds both on its own inbox and `read` on its own events, its children's events and its sandbox's events; events channels are posted by the platform only. A grant's wildcards match free channels only, never `user` or a built-in channel.

**No interop for now:** [A2A](https://a2a-protocol.org/latest/specification/) is client-to-server tasks with no pub/sub, and [MCP tasks](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) have no agent-to-agent features. Either could be an adapter at the edge later.

These are starting defaults ("balanced"), tuned from experience.

**External events** (webhooks, email) arrive as posts too, tainted and attributed to their hook. See [sources/](sources/).

**Implementation:** one [ChannelDO](../control-plane/durable-objects/channel/) per channel; it lists what is built and what isn't. Deliveries enter AgentDO's turn queue and inbox like any other input ([AgentDO](../control-plane/durable-objects/agent/)).
