# Agents

**An agent is a brain plus optional hands.**

- **Brain:** an unmodified Claude Code process running **on a host, outside every VM**, on my subscription. It's managed by the [agent runner](runner/), and its session state is portable.
- **Hands:** `nest` MCP tools that make calls into **one sandbox** (exec, read, write, edit, glob, grep). See [hands/](hands/).
- **Worker:** brain + hands, running on the burst host next to its sandbox.
- **Captain:** brain only, running on the controller host. See [../orchestration/captains/](../orchestration/captains/).

```
host                                                 sandbox VM
agent-runner → claude (no local exec/FS tools)       guest agent (hands server)
   │ nest-mcp: hands ─────────── RPC over vsock ───►  exec · fs · pty
   │ nest-mcp: platform ─► AgentDO
   └ subscription token: process env only (never in a VM)
```

**Scope:** Claude Code is the only harness for now.

## Attach, share, fork

- **Attach** means binding an agent's hands to a sandbox. **Moving** an agent means rebinding them. A forked conversation (`--resume <id> --fork-session`) can be bound to a forked sandbox.
- **Several agents in one sandbox** are several RPC clients. They share files, services and ports, and conflicts are accepted. No worktrees, port blocks or per-agent uids.
- **Isolation comes from forking the sandbox.**
- **Per-agent grants provide attribution and prevent accidents.** Within one sandbox, they aren't a security boundary.

**Cross-workstream rule:** agents never attach across workstreams. Captains have no hands. To inspect a workstream they use `delegate`: a read-only worker in an ephemeral fork.

## Components

- [runner/](runner/): starts and drives Claude Code, keeps its environment clean, handles auth and placement
- [hands/](hands/): MCP tools modeled on Claude Code's built-ins, executed in the sandbox over RPC
- [sessions/](sessions/): the native session file, tailed on the host and stored in R2
- [state-tracking/](state-tracking/): hooks and the stream, an async pipeline, and synchronous decisions answered locally
- [tools/](tools/): platform tools, brokered actions, grants, and the `nest` CLI inside sandboxes
