# Agents

**An agent is a brain plus optional hands, with capabilities, grants and subscriptions.** There are no roles: what an agent is for comes from its prompt and the capabilities it's given.

- **Brain:** an unmodified Claude Code process running **on a host, outside every VM**, on my subscription. It's managed by the [agent runner](runner/), and its session state is portable. The [backend](backends/) is pluggable; `api-loop` (later) runs inside the control plane, with no host at all.
- **Hands (optional):** `nest` MCP tools that make calls into **one sandbox** (exec, read, write, edit, glob, grep). See [hands/](hands/).
- **Capabilities:** pluggable bundles of tools, the grants they need and prompt instructions (messaging, channels, spawning, memory, …). See [capabilities/](capabilities/).
- **Grants:** what it may do, and to which resources. Capabilities expand into grants; extra grants can be added. See [tools/](tools/).
- **Subscriptions:** the [channels](../channels/) whose messages wake it. Every agent is subscribed to its own inbox.
- **Owner and labels:** the agent that spawned it (or me), and free-form key/values for grouping.

```
host                                                 sandbox VM
agent-runner → claude (no local exec/FS tools)       guest agent (hands server)
   │ nest-mcp: hands ─────────── RPC over vsock ───►  exec · fs · pty
   │ nest-mcp: platform ─► AgentDO ─► channels · agents · sandboxes
   └ subscription token: process env only (never in a VM)
```

**Scope:** Claude Code is the only harness for now.

## Spawning

`agent_spawn(spec)`. A spec is a template name plus overrides:

```yaml
template:      worker              # optional; the fields below override it
launch:        {system_prompt, builtin_tools, model, effort}   # becomes Claude Code flags
backend:       claude-code         # or api-loop (later; agents without hands only)
hands:         {sandbox, cwd?}     # or null
capabilities:  [messaging{peers: label:workstream}, memory, ...]   # see capabilities/
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
- **Placement follows hands:** an agent with hands runs on its sandbox's host, where hands RPC is local vsock. One without hands runs on a controller host, or, with `api-loop`, nowhere.
- **Ownership:** the spawner owns the new agent and holds every grant on it: post to its inbox, stop it, attach it, read its transcript. It's subscribed to the new agent's `events` by default, so the agent's final text comes back when it finishes.
- **Budgets shrink like grants:** a child's budget is carved from its spawner's remaining budget and enforced per owner subtree. That bounds spawn depth, fan-out and quota, the runaway modes seen in practice ([Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system) once spawned 50 subagents for a simple query). An agent over budget is parked and escalates.
- **Fencing:** an agent with hands presents its sandbox's epoch; one without hands presents 0 and is fenced by its host's lease.

## Continuity

- **Each wake picks resume or fresh.** A woken agent resumes its session (`--resume`) when that's cheap: the prompt cache is still warm (it lasts an hour on a subscription, [docs](https://code.claude.com/docs/en/prompt-caching)) or the session is small. The starting rule: **resume if the last turn was under an hour ago or the session is under about 50k tokens**; otherwise start a fresh session, seeded with its memory index and the wake envelope. A fresh session also clears [taint](tools/#taint-and-sinks). The first spike measures whether the rule is right.
- **One memory system:** memory is a private keyed channel. Claude Code's own auto memory is off (it's local to one host), and a `SessionStart` hook injects the memory key index at startup and after compaction.
- **The session file is a cache** of a format Claude Code doesn't stabilize; the durable state is the R2 copy plus memory. See [sessions/](sessions/).

## Attach, share, fork

- **Attach** binds an agent's hands to a sandbox, and needs `attach` on both. **Moving** an agent rebinds them. A forked conversation (`--resume <id> --fork-session`) can be bound to a forked sandbox.
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

- [backends/](backends/): `claude-code` (current) and `api-loop` (future), chosen per agent
- [capabilities/](capabilities/): pluggable bundles of tools, grants and prompt (messaging, channels, spawning, memory, …)
- [runner/](runner/): starts and drives Claude Code, keeps its environment clean, handles auth and placement
- [hands/](hands/): MCP tools modeled on Claude Code's built-ins, executed in the sandbox over RPC
- [sessions/](sessions/): the native session file, tailed on the host and stored in R2
- [state-tracking/](state-tracking/): hooks and the stream, an async pipeline, and synchronous decisions answered locally
- [tools/](tools/): platform tools, grants, brokered actions, and the `nest` CLI inside sandboxes
