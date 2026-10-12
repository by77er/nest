# Tools

`nest-mcp` runs on the host next to each brain and serves two groups of tools:

| Group | Examples | Executes |
|---|---|---|
| **[Hands](../hands/)** | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep` | In the bound sandbox, over vsock RPC |
| **Messaging** | `notify(to)`, `emit(event)`, `ask(question, options)` | AgentDO, which routes to a captain, to me (Discord) or to another agent's inbox |
| **Platform** | `fork_sandbox`, `spawn_agent`, `attach`, `read_transcript`, `checkpoint` | Control plane, scoped by role |
| **Brokered actions** | `github.create_pr`, `email.send`, `http.request(profile)` | Control plane, with secrets that never reach a sandbox |

- **Identity:** the runner knows which agent each MCP process belongs to and authenticates to the control plane with its host token. Stale epochs are rejected.
- **Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call_id)` → write to the journal.
- **Never block on a human:** `ask()` and approvals wait at most about 2 minutes. After that they return `pending`, the turn ends, and the answer arrives as the next turn's input.
- **Inbound messages** are queued in AgentDO and delivered mid-turn through stdin or the `Stop` hook inbox. `interrupt: true` interrupts the current turn.

**The `nest` CLI inside sandboxes:** scripts and programs running in a sandbox can call `nest notify` and similar commands through the guest agent over vsock. `NEST_AGENT_ID`, set on every hands exec, attributes the call. It isn't a secret, because identity inside a sandbox is attribution only.

**Grants:**
```
worker:  hands(bound sandbox), notify(captain), emit, ask, github.create_pr(repo=X), http.request(profile=docs)
captain: no hands; spawn_workstream, delegate, read_transcript, approve, notify_user, … (see orchestration/captains/)
```
