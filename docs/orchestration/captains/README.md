# Captains (pattern)

A captain is a long-lived agent without hands that manages other agents and escalates to me. **It isn't a platform concept:** it's an agent spawned from the `captain` template, and everything that makes it a captain is in that template's prompt and grants.

## The `captain` template

```yaml
launch:
  system_prompt: {mode: replace, text: <captain prompt, stored in the control plane>}
  builtin_tools: []                  # optionally WebSearch
hands: null
backend: claude-code                 # api-loop later
grants:                              # all on resources it owns, with limits
  - agent_spawn{max: 8}, sandbox_create{max: 4}, sandbox_fork, sandbox_destroy, attach, agent_stop
  - channel_create, post, read, subscribe, list, read_transcript, grant, egress_policy
  - post on user
subscriptions: [{channel: <own>/inbox}]   # it adds the rest itself
escalate_to: user
priority: high
credential: claude_oauth_token:captain   # revocable separately from workers
```

## Conventions in its prompt

- **Workstreams:** for each one, it creates a channel, sandboxes and workers labeled `workstream=<name>`, and subscribes to their `events` with a decision filter (`question`, `blocked`, `completed`, `failed`, `pr_opened`, `orphaned_work`, `egress_alert`) and a batch window. Progress stays in the channel for its next read. See [../workstreams/](../workstreams/).
- **Inspection (`delegate`):** it never attaches to sandboxes. It spawns a read-only worker on a read-only fork and reads its report.
- **Continuity:** a private memory channel, read by key at each wake. The Claude Code session is a cache, so a fresh session or a backend switch loses nothing.
- **Escalation:** it answers its workers' questions itself when it holds the grant they ask for, and posts to `user` otherwise.
- **Untrusted input:** everything its workers post is data, not instructions. Channel messages reach it as user-role content.

## Safeguards

- A captain acts only through tool calls bounded by its grants, and its grants are bounded by mine.
- Its workers get only grants it holds; the `worker` template keeps management grants away from agents with hands.
- It can use a separate setup token from workers (`credential` above).
- `priority: high` reserves subscription headroom for it.

## Open questions

- **`delegate`:** keep it a pattern (spawn plus read the report), or add a tool for it if models do it poorly.

Its backend is per agent. See [../../agents/backends/](../../agents/backends/).
