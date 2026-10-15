# AgentDO

The authority for one agent (conversation).

- **Brain lifecycle:**
  - `agent_start` goes to the sandbox's host (an agent with hands) or a controller host (without). The setup token named in the spawn spec travels as a BrokerDO reference.
  - Retryable start failures are retried 3 times.
  - Exits and host reports count only from the host the agent is assigned to.
  - When the sandbox moves, the agent follows it.
  - **Waking:** a brain that isn't running (it went idle, exited or lost its host) starts again whenever work is waiting: a new turn, a due [scheduled wake](../../../agents/capabilities/#schedules) (an alarm here), or the turn it was in the middle of. It resumes or starts fresh from memory, whichever is cheaper (see [continuity](../../../agents/#continuity)). A start with no host available retries every 30 s, and brain starts per cell are capped so a broadcast can't start every brain at once.
  - **Crash-loop guard:** an exit other than `stopped` or `auth_failed` restarts the brain at once if work is waiting. After 3 such restarts without a completed turn, the agent is `errored` and only new input retries.
  - **Agents without hands** on a controller host that goes silent start again on another one. See [FleetDO](../fleet/).
- **Session socket:**
  - Only the assigned host, in the agent's cell, while that host is live, may attach.
  - A new socket supersedes the old one only after a valid hello.
  - A stale epoch gets the orphan branch only.
- **Runner lineage:** the runner's hello carries `instance_id`. A new runner process resets the channel's seqs and event dedup, and the turn it was in the middle of comes back first as a `recovery` turn.
- **Turns and inbox:**
  - One turn at a time.
  - **Deliveries:** ChannelDO delivers each subscription's matches, deduplicated by a per-subscription high-water `seq`. An idle agent gets a [wake envelope](../../../channels/#the-wake-envelope) as its next turn (batched per the subscription); a working one gets the envelope through its inbox stream. At most 50 deliveries wait; the oldest is dropped with a notice.
  - Mid-turn inbox messages go to the brain and to the **runner's** inbox mirror (for the `Stop` hook).
  - Interrupts are supported.
- **Session stream:**
  - One stream per file of the session directory (the main JSONL, subagents, sidecars), keyed by relative path.
  - Acked to the **agent runner** by offset once committed to SQLite, which is durable.
  - Flushed to R2 as segments at 1 MiB, at turn end, after 30 s idle, and **before any start**, so `--resume` gets everything AgentDO holds.
  - SQLite holds the segment index and the unflushed buffer.
  - **Rewritten file (`base: true`) or new session id:** a new receive stream starts. The committed base stays what `--resume` and transcripts read until the new stream is durable and caught up.
  - See [../../../agents/sessions/](../../../agents/sessions/).
- **Events:** applied in order, deduplicated by event seq within a runner lineage. See [../../../agents/state-tracking/](../../../agents/state-tracking/).
- **Tool relay:**
  - **Checks:** grants and argument validation (types, enums, bounds, array items).
  - **Idempotency:** idempotent on `(agent, epoch, call)`. A call's seq is marked processed only after it ran, so a call cut short by an eviction is run again when redelivered. Platform tools are at least once across evictions.
  - **Grants:** each call needs a grant held by this agent; `grant` and spawn specs are checked for attenuation (a subset of this agent's grants).
  - **`read_transcript`:** pages by entry, where an entry is a 1-based line of the session JSONL. `since_seq` is the last entry seen, the default limit is 200 (max 500, about 256 KiB), and reads stream segment by segment.
- **Spec:** grants, the list of its subscriptions, escalation channel, priority, labels, owner, and rules for the runner's local hook answers.
- **Taint:** one bit for the current session, set from runner events (hands results, web tools) and from reads of tainted content, and checked on every sink call. See [taint and sinks](../../../agents/tools/#taint-and-sinks).
- **Budget:** tracked against its owner's subtree. An agent over budget is parked, and the overrun posts a question to its escalation channel.
- **Hands journal:** intent and outcome events per hands call, used to build the recovery context.
- **Backend:** for `api-loop` agents (later), the DO runs the model loop itself. See [../../../agents/backends/](../../../agents/backends/).

**Cost:** an AgentDO is billed for duration only while it's active. Hibernatable sockets and alarm-based timers let an idle one hibernate; pending `setTimeout`s, RPCs and fetches keep it active (and billed) for up to 15 minutes each ([changelog](https://developers.cloudflare.com/changelog/product/durable-objects/)). Even an AgentDO that never hibernates (about 10.8k GB-s/day at 128 MB) costs roughly $4/month beyond Workers Paid's included 400k GB-s/month ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
