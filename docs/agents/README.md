# Agents

**An agent is a brain plus optional hands, with capabilities and grants.** There are no roles: what an agent is for comes from its prompt and the capabilities it's given.

- **Brain:** an unmodified Claude Code process running **on a [brain host](../compute/brain-hosts/), outside every VM and never on a sandbox host**, on my subscription. It's managed by the [agent runner](runner/), and its session state is portable. The [backend](backends/) is pluggable; `api-loop` (deferred) runs inside AgentDO, with no host at all.
- **Hands (optional):** `nest` MCP tools that make calls into **one sandbox** (exec, read, write, edit, glob, grep), over the network through the sandbox's [gateway](../sandbox/gateway/), with a binding SandboxDO's `resolve` issues to an attached agent. See [hands/](hands/).
- **Capabilities:** pluggable bundles of tools, the grants they need and prompt instructions (messaging, spawning, MCP servers, brokered actions, …). See [capabilities/](capabilities/).
- **Grants:** what it may do, and to which resources. Capabilities expand into grants; extra grants can be added. See [tools/](tools/).
- **Input:** turns and inbox messages queued in its AgentDO (`POST /v1/agents/<id>/turns` and `/inbox`, a spawner's task, an answered ask). Channels and their subscriptions left the platform ([principle 9](../README.md#principles)): coordination tools are external integrations reached over MCP.
- **Owner and labels:** the agent that spawned it (or me), and free-form key/values for grouping.

```
brain host (no KVM)                          sandbox host (spot, KVM)
agent runner → claude (no local               gateway ── vsock ──► guest agent (hands server)
  exec/FS tools)                                 ▲                  exec · fs · pty
   │ nest mcp: hands ─► hands client ────────────┘ one WebSocket per call over the host's tunnel, binding first
   │ nest mcp: platform ─► AgentDO ─► agents · sandboxes · MCP servers
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
capabilities:  [coordination, web, ...]   # see capabilities/
grants:        [...]               # extra grants; everything must be a subset of the spawner's
budget:        {depth, concurrent, spawns, turns_per_day}   # at most what the spawner has left
report_schema: {...}               # optional: a final report that matches it reaches the spawner untainted
priority:      normal              # or high; see quota scheduling
labels:        {project: auth}
credential:    claude_oauth_token  # or a named one, e.g. claude_oauth_token:captain
```

- **Built so far:** the admin API's spawn is `{template, sandbox?, owner?, overrides?}` (a `workstream` an old client sends is ignored for one release), expanded by [CatalogDO](../control-plane/durable-objects/catalog/) (the fields above that aren't built: backend, grants, budget, report schema, priority, labels). An agent's own spawn is the `agent_spawn` tool: `{template, task, sandbox?: new | share, ephemeral?, sandbox_idle_ttl_s?, tools?, repos?}`, from a template one of its capabilities names in `spawn` (the spawn grant; the seeded `spawning` capability names `worker`), its overrides only narrowing; `task` is the child's first input. The child gets its spawner's workstream and cell, its taint (sticky, and on the task), and depth plus one. Its ids (and a new sandbox's) come from the call's key, so a re-run makes nothing twice.
- **Interim limits, until budgets** (confirmed by the owner, 2026-11-02): spawn depth at most 3 (the operator's agents are 0) and at most 8 children that haven't ended, per spawner (`lib/lifetimes.ts`). The design's budgets replace them.
- **Templates** are named specs stored in the control plane and edited by me, mostly a list of [capabilities](capabilities/). `captain` and `worker` are just the two I start with. See [../orchestration/](../orchestration/).
- **Brain placement is by backend and capacity, never by sandbox:** a `claude-code` brain starts on any [brain host](../compute/brain-hosts/) with capacity, preferring the host that ran the agent last (a warm session file), a preference and not a rule; an `api-loop` brain needs no host. Hands are a binding to one sandbox, reached through its [gateway](../sandbox/gateway/) from wherever the brain runs.
- **Ownership:** the spawner owns the new agent and holds every grant on it: post to its inbox, stop it, attach it, read its transcript. A child's events (a finished turn's text, its exit) are to reach it as agent events delivered to owners, part of the kernel but not built ([principle 9](../README.md#principles)): today a spawner isn't told when a child finishes. **Built:** recorded once, as the child's `owner` (the deciding record; the spawner's `children` table is an index of it), and transitive: an owner holds the same grants on what its children own. Today only `agent_stop` checks it (by walking the target's owner chain); the grants system takes it over as `(spawner, *, child)` grants derived from the spawner's own.
- **Budgets shrink like grants:** a child's budget is carved from its spawner's remaining budget and enforced per owner subtree. That bounds spawn depth, fan-out and quota, the runaway modes seen in practice ([Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system) once spawned 50 subagents for a simple query). An agent over budget is parked and escalates.
- **Fencing:** AgentDO issues an **agent epoch** per brain start. Platform tool calls and brokered actions carry it, and a brain host whose lease lapses kills its brains, which AgentDO restarts on another brain host after 30 s with `--resume`. Hands calls carry the **sandbox epoch** inside the binding, checked by the gateway and again by the guest. Brokered actions don't carry it yet: see [the runner](runner/).

## Lifetimes

An agent lives until it **ends**: stopped for good, as opposed to an operator's stop, which its next input lifts. Built (`lib/lifetimes.ts`, [AgentDO](../control-plane/durable-objects/agent/#ending)); the owner confirmed these defaults on 2026-11-02 (the cascade, the ungated `exit`, ephemeral "done", the 30-day records):
- **`agent_stop {agent, destroy_sandbox?}`** ends an agent the caller owns, directly or through the agents it owns. Its brain is killed, its queued turns are dropped (`dropped`), and the agents it owns end too (each killed). The operator's `POST /v1/agents/<id>/stop {end: true}` does the same.
- **`exit {destroy_sandbox?}`** ends the caller once its current turn is done. Every agent has it, outside its spec: it only gives up authority, so it is never gated, not even for a tainted session (an injected `exit` can end the agent, the agents it owns and the sandbox made for it, nothing else).
- **Ephemeral** agents (`ephemeral: true` in the template, or set by the spawn; a spawn can't clear the template's) end themselves when they are **done: a turn completes with no turn queued, no open ask or approval (whose answer would be its next turn), and no agent it spawned that hasn't ended** (whose result would be). Background hands tasks aren't waited for, and an ask nobody answers keeps it (and its sandbox) alive until its owner stops it. A one-shot worker's task is its first turn, so it ends when that turn does, unless its owner sent more meanwhile.
- **An ended agent takes nothing:** to senders it is gone (`unknown_agent`), no start or wake runs, and its owner's index records it ended (`childEnded`).
- **Its sandbox:** an ended agent is detached from it. With `destroy_sandbox` (always for an ephemeral agent), the sandbox made for it (`agent_spawn{sandbox: new}`, which it owns) is destroyed once its brain is gone, unless another agent is still attached. Any other sandbox it leaves behind is destroyed by its [idle TTL](../control-plane/durable-objects/sandbox/#lifetime) once nobody is attached.
- **Its records** (AgentDO's storage and its R2 session segments) go 30 days after it ended.

**Why the end cascades** (where an operator's stop and interrupt don't): an ended agent can no longer manage what it owns, and nobody else does, so leaving them would leak; its owner chain still reaches them meanwhile.

## Continuity

- **Memory is for long-lived agents only.** Monitors, personal assistants and captains, which live for weeks and wake many times, get the `memory` capability. Ephemeral agents (task workers, readers) get none: they finish in one session or a few, their transcript carries them, and their results reach their spawner. Memory that nobody needs is context to load, taint to carry and state to tidy.
- **Agents without memory always resume** their session, since there's nothing else to restart from.
- **Agents with memory pick resume or fresh at each wake.** A woken agent resumes its session (`--resume`) when that's cheap: the prompt cache is still warm (it lasts an hour on a subscription, [docs](https://code.claude.com/docs/en/prompt-caching)) or the session is small. The starting rule: **resume if the last turn was under an hour ago or the session is under about 50k tokens**; otherwise start a fresh session, seeded with its memory index and the input that woke it. A fresh session starts untainted unless the wake that starts it carries [taint](tools/#taint-and-sinks) or it then reads tainted content. A turn cut off by a crash always resumes, since its context is in the transcript. The first spike measures whether the rule is right.
- **One memory system:** a keyed store the `memory` capability reaches (an external integration over MCP, [principle 9](../README.md#principles); the seeded `memory_read`/`memory_write` answer `not_implemented`). Claude Code's own auto memory is off for every agent (it's local to one host).
- **The key index is bounded:** for agents with memory, a `SessionStart` hook injects at most 200 keys, most recently written first, plus a count of the rest, at startup and after compaction. The agent lists more through the store's tools. Claude Code's own memory index loads 200 lines the same way ([memory](https://code.claude.com/docs/en/memory)).
- **Upkeep:** the template asks the agent to update and prune memory as it goes, and the `memory` capability schedules a weekly wake asking it to consolidate.
- **The session file is a cache** of a format Claude Code doesn't stabilize; the durable state is the R2 copy plus memory. See [sessions/](sessions/).

## Attach, share, fork

- **Attach** binds an agent's hands to a sandbox, and needs `attach` on both: SandboxDO configures the agent's slot in the guest, and its `resolve` issues the binding. **Moving** an agent is a new binding. A forked conversation (`--resume <id> --fork-session`) can be bound to a forked sandbox.
- **Several agents in one sandbox** are several RPC clients. They share files, services and ports, and conflicts are accepted. No worktrees, port blocks or per-agent uids.
- **Isolation comes from forking the sandbox.**
- **Per-agent grants provide attribution and prevent accidents.** Within one sandbox, they aren't a security boundary.
- **Inspecting without hands** is left to agents. The platform offers read-only forks and report schemas, and no `delegate` tool or reader template, so how to inspect is the model's call.

## Removal

**Built:** removal is the [end](#lifetimes): the agents it owns end with it (not parked), and its sandboxes are detached and left to their idle TTL (not archived at once). Labels, `orphaned_from` and adoption below are designed, not built.

When an agent is removed for good, **what it owns is parked, then expires**:
- Owned agents stop with their state kept; owned sandboxes suspend and are archived to S3. Parked resources cost almost nothing (see [scale to zero](../compute/autoscaling/)).
- Everything parked is labeled `orphaned_from=<agent>`, and a notice goes to the removed agent's owner (or to me).
- **Adoption:** that owner, or I, can `adopt` a parked resource and become its owner; grants on it are then issued from the adopter. The removed agent's own grants have already ended with it (see [tools/](tools/)).
- **Expiry:** whatever nobody adopts is destroyed after 30 days. Nothing is lost by accident, and nothing leaks forever.

## Components

- [backends/](backends/): `claude-code` (current) and `api-loop` (deferred), chosen per agent
- [capabilities/](capabilities/): pluggable bundles of tools, grants and prompt (messaging, spawning, MCP servers, brokered actions, …)
- [runner/](runner/): starts and drives Claude Code at a pinned version on brain hosts, keeps its environment clean, handles auth, and reaches hands through the gateway
- [hands/](hands/): MCP tools modeled on Claude Code's built-ins, executed in the sandbox over RPC through its gateway
- [sessions/](sessions/): the native session file, tailed on the host and stored in R2
- [state-tracking/](state-tracking/): hooks and the stream, an async pipeline, and synchronous decisions answered locally
- [tools/](tools/): platform tools, grants, brokered actions, and the `nest` CLI inside sandboxes
