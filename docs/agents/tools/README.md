# Tools

`nest-mcp` runs on the host next to each brain. **Every tool is open to any agent holding the grant for it;** there are no role-specific tools.

| Group | Tools | Executes |
|---|---|---|
| **[Hands](../hands/)** | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskOutput`, `TaskStop` | In the bound sandbox, over vsock RPC |
| **Channels** | `channel_create`, `post` (optionally awaiting a reply), `read` (optionally waiting up to 120 s), `subscribe`, `unsubscribe` | ChannelDO. See [../../channels/](../../channels/) |
| **Agents** | `agent_spawn`, `agent_stop`, `attach`, `read_transcript`, `list` (any resource kind, filtered by labels) | Control plane |
| **Sandboxes** | `sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy` | Control plane |
| **Authority** | `grant`, `revoke` | Control plane |
| **Brokered actions** | `github.create_pr`, `email.send`, `http.request(profile)` | Control plane, with secrets that never reach a sandbox |

**Messaging and memory are channel operations.** Notifying someone is `post` to their inbox or to `user`. An event is a `post` with a `kind`. Asking is `post` with `await_reply_s`. Waiting for events is `subscribe`, or `read` with a wait. Memory is a private channel read by key.

## Grants

A grant is `(principal, action, resource, limits?, expires?)`. A resource is an id, a label selector (`sandbox{workstream=auth}`), or `own` (whatever the principal owns, now or later).

- **Attenuation:** an agent can grant, or put in a spawn spec, only grants it holds, with equal or tighter limits. I hold the root, so authority flows down from me and only shrinks.
- **Ownership:** creating a resource gives its creator every grant on it.
- **Limits ride on grants:** e.g. `agent_spawn{max: 5}`, `sandbox_create{max: 3, memory_mb ≤ 4096}`.
- **Checked twice:** AgentDO filters `tools_list` by grants, then checks every `tool_call` again.
- **Approval:** `requires_approval` actions always post a `question` to the agent's escalation channel first.
- **Template defaults, not platform rules:** the default templates keep management grants (`agent_spawn`, `grant`, `attach`) away from agents with hands, because those read untrusted content.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call_id)` → write to the journal.

- **Identity:** the runner knows which agent each MCP process belongs to and authenticates to the control plane with its host token. Stale epochs are rejected.
- **Never block on a human:** `post` with `await_reply_s` and approvals wait at most about 2 minutes. After that they return `pending`, the turn ends, and the reply arrives as a later turn.
- **Inbound messages** are delivered from the agent's subscriptions: mid-turn through stdin or the `Stop` hook inbox, otherwise as the next turn. A post flagged `interrupt` interrupts the current turn if the poster holds `interrupt` on the agent.

## The `nest` CLI inside sandboxes

Scripts and programs running in a sandbox can call `nest post`, `nest read` and `nest expose` through the guest agent over vsock. `NEST_AGENT_ID`, set on every hands exec, attributes the call, and it runs with that agent's grants. It isn't a secret, because identity inside a sandbox is attribution only. `spawn`, `attach`, `grant` and policy changes need a brain, so the CLI never offers them.

## Open questions

- **Revocation:** whether revoking a grant also revokes the grants passed on from it. That needs each grant to record where it came from.
- **Sandbox programs:** whether in-sandbox programs act with the attributed agent's grants (as above), or with a smaller grant set of the sandbox's own.
