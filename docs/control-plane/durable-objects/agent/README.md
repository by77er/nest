# AgentDO

The authority for one agent (conversation).

- **Brain lifecycle:**
  - `agent_start` goes to a [brain host](../../../compute/brain-hosts/) AgentDO picks by capacity, preferring the host that ran the agent last; where the agent's sandbox runs plays no part. An operator may name the host (`POST /v1/agents/<id>/start {host}`, an active host in the agent's cell) to pin a brain for a test. For `api-loop` the loop runs in this DO. The setup token named in the spawn spec travels as a BrokerDO reference.
  - **Agent epoch:** each start issues one. Platform tool calls and brokered actions carry it, and ones from an older epoch are rejected. Hands calls carry the sandbox's epoch instead, inside the binding.
  - **Hands:** for an agent with hands, `create` calls SandboxDO `attach`, and `agent_start` names the sandbox and its epoch only. The runner fetches the target (gateway URL, binding, guest version) with `hands_resolve` on its session channel, which AgentDO answers from SandboxDO's `resolve`, and only on the current runner's socket: a stale runner (an older epoch or a superseded process) gets `stale_epoch` and no binding. The binding never passes through FleetDO, nestd or a stored command. The brain stays where it is when its sandbox moves: its next call is refused, it re-resolves, and the recovery turn tells it what was lost ([SandboxDO](../sandbox/)). Built today: `onSandboxMoved` still restarts the brain, which resolves afresh.
  - Retryable start failures are retried 3 times.
  - Exits and host reports count only from the host the agent is assigned to.
  - **Waking:** a brain that isn't running (it went idle, exited or lost its host) starts again whenever work is waiting: a new turn, a due [scheduled wake](../../../agents/capabilities/#schedules) (an alarm here), or the turn it was in the middle of. It resumes; an agent with memory starts fresh from it instead when its last turn was over an hour ago and its session is over ~50k tokens. A turn cut off by a crash always resumes. See [continuity](../../../agents/#continuity). A start with no host available retries every 30 s, and brain starts per cell are capped so a broadcast can't start every brain at once.
  - **Crash-loop guard:** an exit other than `stopped` or `auth_failed` restarts the brain at once if work is waiting. After 3 such restarts without a completed turn, the agent is `errored` and only new input retries.
  - **A brain whose host goes silent** for 30 s starts again on another brain host; its sandbox, if it has one, is untouched. See [FleetDO](../fleet/).
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
  - **Admission is idempotent:** a turn or inbox post with a `request_id` (body, or `Idempotency-Key`) that AgentDO has seen returns the same turn or message, queued once.
  - **Recovery turn:** a turn cut off by a brain restart (a new runner process) comes back first as a `recovery` turn, the only way an interrupted turn continues: the runner never sets `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, so Claude Code can't also continue it. It says where the durable transcript ends (actions after that may have taken effect without appearing in it), and, if the sandbox moved during the turn, the time of the head generation it was restored from (changes after that are lost; processes stopped when it was disk-only). Interrupted again, it keeps the original turn's text. The outcomes of hands calls that were in flight come from `call_status` through the gateway ([hands](../../../agents/hands/)).
  - **No cascade:** stopping or interrupting an agent affects only that agent. The platform has no spawn tree (structures are conventions); a captain stops its workers explicitly. Its open asks stay answerable, and an answer becomes its next turn.
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
  - **Idempotency:** idempotent on `(agent, epoch, call)`. A call's seq is marked processed only after it ran, so a call cut short by an eviction is run again when redelivered. A re-run repeats no side effect: every write a tool makes to another object carries the key `<agent>/<epoch>/<call>`, applied once by its target (WorkstreamDO events and user notifications, the recipient's inbox), and an `ask` re-run reuses its question. A new mutating tool must do the same before it ships.
  - **Grants:** each call needs a grant held by this agent; `grant` and spawn specs are checked for attenuation (a subset of this agent's grants).
  - **Changes under a live session:** grants and rules apply at the next call (a revoked tool fails at once). The tool list the model sees comes from MCP `tools/list` at brain start, so a new tool appears at the next start, and a changed schema is validated against the current catalog. Upgrades that replace the brain mid-turn go through the recovery turn.
  - **`read_transcript`:** pages by entry, where an entry is a 1-based line of the session JSONL. `since_seq` is the last entry seen, the default limit is 200 (max 500, about 256 KiB), and reads stream segment by segment. Each page names its `base`; a reader passes it back with `since_seq`, and if the file was rewritten since (a new base), the page starts again from entry 1 with `reset`. The HTTP transcript (`?since=&base=`) is the same cursor, so a client attaching mid-turn reads to `more: false`, then polls from `next_seq`.
- **Spec:** grants, the list of its subscriptions, escalation channel, priority, labels, owner, and rules for the runner's local hook answers.
- **Taint:** one bit for the current session, set from runner events (hands results, web tools), from `mcp` and `api` capability results, from tainted wakes and from reads of tainted content, and checked on every sink call. See [taint and sinks](../../../agents/tools/#taint-and-sinks).
- **Budget:** tracked against its owner's subtree. An agent over budget is parked, and the overrun posts a question to its escalation channel.
- **Hands outcomes:** the runner's `tool_call` and `tool_result` canonical events, plus the `call_status` lookups it makes after a crash, build the recovery context. Nothing about hands arrives from nestd.
- **Backend:** for `api-loop` agents (deferred until the API credits are picked up), the DO runs the model loop itself and opens one outbound WebSocket to the sandbox's gateway per hands call, with the same binding a runner would hold. See [../../../agents/backends/](../../../agents/backends/).

**Not built:** deliveries from ChannelDO, scheduled wakes, the resume-or-fresh choice, the per-cell start cap, the spec (capabilities, grants, subscriptions, owner, labels), taint, budgets, the agent epoch and brain placement by capacity. Session bytes are acked after the R2 put and flushed every 5 s, the code still keys agents by role and workstream, and it starts captains on a `controller` host and other brains on the sandbox's host. See `control-plane/README.md`.

**Cost:** an AgentDO is billed for duration only while it's active. Hibernatable sockets and alarm-based timers let an idle one hibernate; pending `setTimeout`s, RPCs and fetches keep it active (and billed) for up to 15 minutes each ([changelog](https://developers.cloudflare.com/changelog/product/durable-objects/)). Even an AgentDO that never hibernates (about 10.8k GB-s/day at 128 MB) costs roughly $4/month beyond Workers Paid's included 400k GB-s/month ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). An `api-loop` brain's outbound WebSocket to a gateway does not hibernate and holds the object in memory for up to 15 minutes ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)), so the DO is billed while a hands call is open: an agent spending two hours a day in hands calls uses about 27,000 GB-s a month, inside the included amount.

**Not built:** removing an agent for good, so nothing calls `SandboxDO.detach` yet; a stopped agent keeps its slot and its gateway client entry until its sandbox's epoch moves.
