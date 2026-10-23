# Agents

**An agent is a brain plus optional hands, with capabilities, grants and subscriptions.** There are no roles: what an agent is for comes from its prompt and the capabilities it's given.

- **Brain:** an unmodified Claude Code process running **on a [brain host](../compute/brain-hosts/), outside every VM and never on a sandbox host**, on my subscription. It's managed by the [agent runner](runner/), and its session state is portable. The [backend](backends/) is pluggable; `api-loop` (deferred) runs inside AgentDO, with no host at all.
- **Hands (optional):** `nest` MCP tools that make calls into **one sandbox** (exec, read, write, edit, glob, grep), over the network through the sandbox's [gateway](../sandbox/gateway/), with a binding SandboxDO issues at `attach`. See [hands/](hands/).
- **Capabilities:** pluggable bundles of tools, the grants they need and prompt instructions (messaging, channels, spawning, memory, …). See [capabilities/](capabilities/).
- **Grants:** what it may do, and to which resources. Capabilities expand into grants; extra grants can be added. See [tools/](tools/).
- **Subscriptions:** the [channels](../channels/) whose messages wake it. Every agent is subscribed to its own inbox.
- **Owner and labels:** the agent that spawned it (or me), and free-form key/values for grouping.

```
brain host (no KVM)                          sandbox host (spot, KVM)
agent runner → claude (no local               gateway ── vsock ──► guest agent (hands server)
  exec/FS tools)                                 ▲                  exec · fs · pty
   │ nest mcp: hands ─► hands client ────────────┘ one WebSocket per call over the host's tunnel, binding first
   │ nest mcp: platform ─► AgentDO ─► channels · agents · sandboxes
   └ subscription token: process env only (never on a sandbox host, never in a VM)
```

**Scope:** Claude Code is the only harness for now.

## Spawning

`agent_spawn(spec)`. A spec is a template name plus overrides:

```yaml
template:      worker              # optional; the fields below override it
launch:        {system_prompt, builtin_tools, model, effort}   # becomes Claude Code flags
backend:       claude-code         # or api-loop (deferred)
hands:         {sandbox, cwd?}     # or null
capabilities:  [messaging{peers: label:workstream}, web, ...]   # see capabilities/
grants:        [...]               # extra grants; everything must be a subset of the spawner's
budget:        {depth, concurrent, spawns, turns_per_day}   # at most what the spawner has left
subscriptions: [{channel, filter, delivery, batch_ms}]
report_schema: {...}               # optional: a final report that matches it reaches the spawner untainted
escalate_to:   <channel>           # default: the spawner's inbox
priority:      normal              # or high; see quota scheduling
labels:        {workstream: auth}
credential:    claude_oauth_token  # or a named one, e.g. claude_oauth_token:captain
```

- **Templates** are named specs stored in the control plane and edited by me, mostly a list of [capabilities](capabilities/). `captain` and `worker` are just the two I start with. See [../orchestration/](../orchestration/).
- **Brain placement is by backend and capacity, never by sandbox:** a `claude-code` brain starts on any [brain host](../compute/brain-hosts/) with capacity, preferring the host that ran the agent last (a warm session file), a preference and not a rule; an `api-loop` brain needs no host. Hands are a binding to one sandbox, reached through its [gateway](../sandbox/gateway/) from wherever the brain runs.
- **Ownership:** the spawner owns the new agent and holds every grant on it: post to its inbox, stop it, attach it, read its transcript. It's subscribed to the new agent's `events` by default, so the agent's final text comes back when it finishes.
- **Budgets shrink like grants:** a child's budget is carved from its spawner's remaining budget and enforced per owner subtree. That bounds spawn depth, fan-out and quota, the runaway modes seen in practice ([Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system) once spawned 50 subagents for a simple query). An agent over budget is parked and escalates.
- **Fencing:** AgentDO issues an **agent epoch** per brain start. Platform tool calls and brokered actions carry it, and a brain host whose lease lapses kills its brains, which AgentDO restarts on another brain host after 30 s with `--resume`. Hands calls carry the **sandbox epoch** inside the binding, checked by the gateway and again by the guest.

## Continuity

- **Memory is for long-lived agents only.** Monitors, personal assistants and captains, which live for weeks and wake many times, get the `memory` capability. Ephemeral agents (task workers, readers) get none: they finish in one session or a few, their transcript carries them, and their results reach their spawner through its subscription to their `events`. Memory that nobody needs is context to load, taint to carry and state to tidy.
- **Agents without memory always resume** their session, since there's nothing else to restart from.
- **Agents with memory pick resume or fresh at each wake.** A woken agent resumes its session (`--resume`) when that's cheap: the prompt cache is still warm (it lasts an hour on a subscription, [docs](https://code.claude.com/docs/en/prompt-caching)) or the session is small. The starting rule: **resume if the last turn was under an hour ago or the session is under about 50k tokens**; otherwise start a fresh session, seeded with its memory index and the wake envelope. A fresh session starts untainted unless the wake that starts it carries [taint](tools/#taint-and-sinks) or it then reads tainted content. A turn cut off by a crash always resumes, since its context is in the transcript. The first spike measures whether the rule is right.
- **One memory system:** memory is a private keyed channel. Claude Code's own auto memory is off for every agent (it's local to one host).
- **The key index is bounded:** for agents with memory, a `SessionStart` hook injects at most 200 keys, most recently written first, plus a count of the rest, at startup and after compaction. The agent lists more with `read(keys_only, prefix)`. Claude Code's own memory index loads 200 lines the same way ([memory](https://code.claude.com/docs/en/memory)).
- **Upkeep:** the template asks the agent to update and prune memory as it goes, and the `memory` capability schedules a weekly wake asking it to consolidate.
- **The session file is a cache** of a format Claude Code doesn't stabilize; the durable state is the R2 copy plus memory. See [sessions/](sessions/).

## Attach, share, fork

- **Attach** binds an agent's hands to a sandbox, and needs `attach` on both: SandboxDO configures the agent's slot in the guest and issues the binding. **Moving** an agent is a new binding. A forked conversation (`--resume <id> --fork-session`) can be bound to a forked sandbox.
- **Several agents in one sandbox** are several RPC clients. They share files, services and ports, and conflicts are accepted. No worktrees, port blocks or per-agent uids.
- **Isolation comes from forking the sandbox.**
- **Per-agent grants provide attribution and prevent accidents.** Within one sandbox, they aren't a security boundary.
- **Inspecting without hands** is left to agents. The platform offers read-only forks and report schemas, and no `delegate` tool or reader template, so how to inspect is the model's call.

## Removal

When an agent is removed for good, **what it owns is parked, then expires**:
- Owned agents stop with their state kept; owned sandboxes suspend and are archived to S3; owned channels become read-only. Parked resources cost almost nothing (see [scale to zero](../compute/autoscaling/)).
- Everything parked is labeled `orphaned_from=<agent>`, and a notice goes to the removed agent's owner (or to me).
- **Adoption:** that owner, or I, can `adopt` a parked resource and become its owner; grants on it are then issued from the adopter. The removed agent's own grants have already ended with it (see [tools/](tools/)).
- **Expiry:** whatever nobody adopts is destroyed after 30 days. Nothing is lost by accident, and nothing leaks forever.

## Components

- [backends/](backends/): `claude-code` (current) and `api-loop` (deferred), chosen per agent
- [capabilities/](capabilities/): pluggable bundles of tools, grants and prompt (messaging, channels, spawning, memory, …)
- [runner/](runner/): starts and drives Claude Code at a pinned version on brain hosts, keeps its environment clean, handles auth, and reaches hands through the gateway
- [hands/](hands/): MCP tools modeled on Claude Code's built-ins, executed in the sandbox over RPC through its gateway
- [sessions/](sessions/): the native session file, tailed on the host and stored in R2
- [state-tracking/](state-tracking/): hooks and the stream, an async pipeline, and synchronous decisions answered locally
- [tools/](tools/): platform tools, grants, brokered actions, and the `nest` CLI inside sandboxes
