# Tools

`nest mcp` runs on the brain host next to each brain. An agent's tools come from its [capabilities](../capabilities/), and every call is checked against its grants; there are no role-specific tools.

| Group | Tools | Executes |
|---|---|---|
| **[Hands](../hands/)** | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskOutput`, `TaskStop` | In the bound sandbox, through its [gateway](../../sandbox/gateway/) |
| **Channels** | `channel_create`, `post` (optionally awaiting a reply), `read` (optionally waiting up to 120 s), `subscribe`, `unsubscribe`, `message` (post to an agent's inbox) | ChannelDO. See [../../channels/](../../channels/) |
| **Agents** | `agent_spawn`, `agent_stop`, `attach`, `adopt` (take ownership of a parked resource), `wake_at` and `wake_cancel` (scheduled wakes on itself), `read_transcript`, `list` (any resource kind, filtered by labels) | Control plane |
| **Sandboxes** | `sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy` | Control plane |
| **Authority** | `grant`, `revoke` | Control plane |
| **Hooks** | `hook_create`, `hook_delete` (external events into a channel; see [sources](../../channels/sources/)) | HookDO |
| **Brokered actions** | `github.create_pr`, `github.review_check`, `github.review_comment`, `github.comment`, `github.create_issue`, `github.dispatch_workflow`, `github.create_webhook`, `email.send`, `http.request(profile)`; each is its own tool (`github_create_pr`, …, `http_request`), and `brokered{action, args}` reaches them all ([brokered](../capabilities/brokered/#tools)) | Control plane, with secrets that never reach a sandbox |
| **Metrics** | `metrics_query` (see [metrics](../../control-plane/metrics/)) | Control plane → Analytics Engine |
| **Tasks** | `task_list`, `task_get`, `task_create`, `task_update`, `task_claim`, `task_comment`; admin: `task_assign`, `task_update_any`, `task_cancel`, `task_set_watcher` | [TaskLedgerDO](../../control-plane/durable-objects/tasks/), on the ledger the agent's spec names |

**Built:** the table is the design. The registry (`protocol/schemas/control/platform-tools.json`) holds interim tools that predate channels and grants: `notify`, `ask`, `emit`, `read_transcript`, `expose_port` and `egress_policy` work; `fork_sandbox`, `spawn_agent`, `attach`, `checkpoint` and the seeded `management` and `memory` capabilities' tools answer `not_implemented`. Brokered actions are built except `github.review_check`, `github.dispatch_workflow`, `github.create_webhook` and `email.send` ([brokered](../capabilities/brokered/)). Hands are built ([hands](../hands/)).

**Messaging and memory are channel operations.** Messaging an agent is `message` (a `post` to its inbox, through the [messaging capability](../capabilities/#messaging)); notifying me is `post` to `user`. An event is a `post` with a `kind`. Asking is `post` with `await_reply_s`. Waiting for events is `subscribe`, or `read` with a wait. Memory is a private channel read by key.

## Grants

A grant is `(principal, action, resource, limits?, expires?, parent)`. A resource is an id, a label selector (`sandbox{workstream=auth}`), or `own` (whatever the principal owns, now or later).

- **Attenuation:** an agent can grant, or put in a spawn spec, only grants it holds, with equal or tighter limits. I hold the root, so authority flows down from me and only shrinks.
- **The chain is the revocation list:** each grant records its `parent` and is valid only while every ancestor is. Limits intersect down the chain. Revoking a grant revokes everything derived from it, and the grants an agent issued end when it's removed. Every call is checked online against one store, so no signed tokens are needed; attenuable tokens ([Biscuit](https://doc.biscuitsec.org/reference/specifications), the [IETF attenuating agent tokens draft](https://www.ietf.org/archive/id/draft-niyikiza-oauth-attenuating-agent-tokens-01.html)) solve offline and cross-domain checks, which nest doesn't have.
- **Ownership:** creating a resource gives its creator every grant on it.
- **Budgets shrink like grants:** see [spawning](../#spawning). An agent over budget is parked and escalates.
- **Checked twice:** AgentDO filters `tools_list` by grants, then checks every `tool_call` again.
- **Approval:** a sink call from a tainted session under `when_tainted: approve` first posts a `question` to the agent's escalation channel (see [taint and sinks](#taint-and-sinks)).

## Taint and sinks

An agent that reads untrusted content, holds private data and can send data out can be made to leak it: the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (2025-06), also framed as the [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) (2025-10). Model robustness helps but isn't a boundary: adaptive attacks broke 12 published defenses at over 90% ([2025-10](https://arxiv.org/abs/2510.09023)). So nest tracks what each session has read, the way [CaMeL](https://arxiv.org/abs/2503.18813) and [FIDES](https://arxiv.org/abs/2505.23643) label data, but per session, which is cheap:

- **Taint is one bit per session, kept by AgentDO and set only by the platform.** It's set by hands output, `WebFetch`/`WebSearch` results, `mcp` and `api` capability results, `read_transcript`, a tainted wake, and reading a tainted message, memory entry or task (a task whose text a tainted session wrote, or a comment one wrote: [task ledger](../../control-plane/durable-objects/tasks/#taint)). It lasts for the session (a `--resume` keeps it).
- **It propagates:** a spawned agent starts with its spawner's taint, every post carries its sender's taint, and every task text write and comment its writer's.
- **Sinks** are the actions that can send data out or widen authority: widening an egress policy, external brokered actions, `mcp` tools not marked read-only, `api` capabilities with `mode: rw`, and granting a sink action. Each sink grant carries `when_tainted: approve | allow` (default `approve`), and attenuation can only tighten it.
- **A sink call from a tainted session** with `approve` posts a question to the escalation channel. Only I or an untainted holder of that grant can approve it (built: only I can; agents can't answer asks).
- **One gate for every sink (built):** a remote MCP tool, a brokered action and `egress_policy` widening all go through the same gate (`control-plane/src/lib/sinks.ts`, AgentDO's `sinkGate`). A gated call isn't sent: it answers `pending` with an ask id, and the operator is asked once per exact call (the same sink with the same arguments asked again before a decision gets the same ask). The decision is a turn. An approval lets through **one** call of that sink with exactly those arguments (SHA-256 of their canonical JSON) within an hour, whichever tool reaches it (`github_create_issue` or `brokered{action: github.create_issue}`); the model calls again. A redelivery of the call it was spent on uses it again. The details and the reason it's asynchronous are in [mcp sinks](../capabilities/mcp/#sinks).
- **Built so far:** a conservative stand-in kept by AgentDO: a session is tainted if the agent has hands or a web built-in, or once another agent's text reached it that may be tainted (sticky): a tainted channel message it read, a `notify` from a tainted agent, an inbox post relayed under another name than `user`, a workstream batch, or another agent's transcript. An untrusted [mcp capability](../capabilities/mcp/#taint)'s tool list or results set it too (a `trusted` one's don't). It guarantees that no such text, and nothing from a sandbox, the web or an untrusted MCP server, reaches a session that then posts untainted; the operator's own text never taints. It over-taints freely (a captain that reads a hands worker's result once is tainted for good). It stamps channel posts. The sinks checked: remote MCP tools ([mcp sinks](../capabilities/mcp/#sinks)), brokered actions ([brokered](../capabilities/brokered/#the-pipeline)) and widening egress (`egress_policy`, always `approve`: a per-grant `when_tainted` for it waits for grants). `api` capabilities and granting sinks aren't built.
- **Ways back to clean:**
  - A fresh session starts untainted unless the wake that starts it carries taint, or it then reads tainted content.
  - **Quarantined reports:** a spawn spec can declare a `report_schema` of enums, numbers and ids. A child's final report that validates against it reaches the spawner untainted, even from a tainted child. This is the dual-LLM / map-reduce pattern from [Design Patterns for Securing LLM Agents](https://arxiv.org/abs/2506.08837) (2025-06), and how a captain stays clean while its workers read code.
- **Template defaults ("balanced", tuned from experience):** widening egress and granting sinks are `approve`. Brokered actions already scoped by their binding (e.g. `github.create_pr` to the binding's repos) are `allow`. Management grants stay off agents with hands.

**Brokered action pipeline:** check the grant and taint → rate limit → scan arguments for secrets → approval gate → read current external state → run with a natural idempotency key (e.g. `(repo, head, base)` for a PR) → write to the journal. Built as designed in AgentDO ([brokered](../capabilities/brokered/#the-pipeline)).

- **Identity:** the runner knows which agent each MCP process belongs to and authenticates to the control plane with its host token. Stale agent epochs are rejected.
- **Never block on a human:** `post` with `await_reply_s` and approvals wait at most about 2 minutes. After that they return `pending`, the turn ends, and the reply arrives as a later turn.
- **Inbound messages** arrive as wake envelopes, with bodies only through `read`; messages from me arrive inline (see [channels](../../channels/#the-wake-envelope)). A post flagged `interrupt` interrupts the current turn if the poster holds `interrupt` on the agent.

## The `nest` CLI inside sandboxes

Scripts and programs running in a sandbox can call `nest post`, `nest read`, `nest expose` and `nest hold` through the guest agent over vsock. Their posts are **always tainted**, and they can reach only the channels the sandbox was created with (`sandbox_create{channels}`; by default just its own `events`). `NEST_AGENT_ID`, set on every hands exec, attributes a post. It isn't a secret, because identity inside a sandbox is attribution only. Everything else needs a brain. The CLI socket takes at most 256 connections ([admission](../../sandbox/guest-agent/#admission)).

`nest hold <duration>` asks to keep the sandbox awake (no pause or suspend) for a background build or a dev server. It's granted up to the sandbox's maximum hold (1 h by default) and prints the granted duration; a later call replaces the hold, and `nest hold 0` ends it ([idle rule](../../control-plane/durable-objects/sandbox/#activity-and-idle)). Nothing inside a sandbox can ask for it to be paused, suspended or shut down.
