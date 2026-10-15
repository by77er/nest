# AgentDO

The authority for one agent (conversation).

- **Brain lifecycle:**
  - `agent_start` goes to the sandbox's host (an agent with hands) or a controller host (without). The setup token named in the spawn spec travels as a BrokerDO reference.
  - Retryable start failures are retried 3 times.
  - Exits and host reports count only from the host the agent is assigned to.
  - When the sandbox moves, the agent follows it.
  - **Waking:** a brain that isn't running (it went idle, exited or lost its host) starts again with `--resume` whenever work is waiting: a new turn, or the turn it was in the middle of. A start with no host available retries every 30 s.
  - **Crash-loop guard:** an exit other than `stopped` or `auth_failed` restarts the brain at once if work is waiting. After 3 such restarts without a completed turn, the agent is `errored` and only new input retries.
  - **Agents without hands** on a controller host that goes silent start again on another one. See [FleetDO](../fleet/).
- **Session socket:**
  - Only the assigned host, in the agent's cell, while that host is live, may attach.
  - A new socket supersedes the old one only after a valid hello.
  - A stale epoch gets the orphan branch only.
- **Runner lineage:** the runner's hello carries `instance_id`. A new runner process resets the channel's seqs and event dedup, and the turn it was in the middle of comes back first as a `recovery` turn.
- **Turns and inbox:**
  - One turn at a time.
  - **Deliveries:** ChannelDO delivers each subscription's matches (`deliver(channel, messages)`), deduplicated by `(channel, seq)`. An idle agent gets them as its next turn (batched per the subscription); a working one gets them through its inbox stream. See [../../../channels/](../../../channels/).
  - Mid-turn inbox messages go to the brain and to the **runner's** inbox mirror (for the `Stop` hook).
  - Interrupts are supported.
- **Session stream:**
  - Buffered and flushed to R2 as segments, every 5 s while working and every 30 s otherwise, or immediately at 1 MiB.
  - Acked to the **agent runner** by offset, **after** the R2 put.
  - SQLite holds only the segment index and the buffer.
  - **Before a start,** buffered bytes are flushed, so `--resume` gets everything AgentDO holds.
  - **Rewritten file (`base: true`) or new session id:** a new receive stream starts. The committed base stays what `--resume` and transcripts read until the new stream is durable and caught up.
  - See [../../../agents/sessions/](../../../agents/sessions/).
- **Events:** applied in order, deduplicated by event seq within a runner lineage. See [../../../agents/state-tracking/](../../../agents/state-tracking/).
- **Tool relay:**
  - **Checks:** grants and argument validation (types, enums, bounds, array items).
  - **Idempotency:** idempotent on `(agent, epoch, call)`. A call's seq is marked processed only after it ran, so a call cut short by an eviction is run again when redelivered. Platform tools are at least once across evictions.
  - **Grants:** each call needs a grant held by this agent; `grant` and spawn specs are checked for attenuation (a subset of this agent's grants).
  - **`read_transcript`:** pages by entry, where an entry is a 1-based line of the session JSONL. `since_seq` is the last entry seen, the default limit is 200 (max 500, about 256 KiB), and reads stream segment by segment.
- **Spec:** grants, the list of its subscriptions, escalation channel, priority, labels, owner, and rules for the runner's local hook answers.
- **Backend:** for `api-loop` agents (later), the DO runs the model loop itself. See [../../../agents/backends/](../../../agents/backends/).

**Cost:** an AgentDO that is streaming stays active, using about 10.8k GB-s/day. This is the main reason for Workers Paid.
