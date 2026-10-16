# State tracking

The runner owns the Claude Code process, so it sees the **stream-json output** directly: tool use, results, per-turn `result` messages (with usage and cost), and `api_retry` events. **Hooks**, which run on the host, add the decision points and the states the stream doesn't show.

## State machine

| Signal | State |
|---|---|
| `SessionStart` | `starting` → `ready` |
| `UserPromptSubmit` / turn input written | `working` |
| Tool use or results (stream, `PreToolUse`/`PostToolUse`) | `working`, plus the current tool |
| `PermissionRequest` | `waiting_permission` (answerable) |
| `Elicitation` | `waiting_input` (async tracking hook) |
| `SubagentStart` / `SubagentStop` | `working`, detail names the subagent |
| `PreCompact` / `PostCompact` | `compacting` |
| `Stop` / `result` | `idle`: updates the sandbox's idle refcount |
| `StopFailure`, or `api_retry` with `rate_limit` | `errored` / `quota_parked` |
| `Notification` | `needs_attention` |
| Process exit / `SessionEnd` | `detached` |
| `rate_limit_event` (stream) | parsed but **not used yet** |

**`stalled`:** `working` with no events for N minutes. A hands call that's still running keeps sending [heartbeats](../hands/), so check whether it's using CPU in its cgroup (`calls/<call_id>`): if it is, it's a long tool call.

## Async pipeline

- Tracking hooks are `async: true` command hooks running `nest hook`, which does one non-blocking write to the runner's socket and always exits 0.
- The runner sends events to AgentDO every 1–2 s, coalesced, with a sequence number per agent. On a gap, state is rebuilt from the session file.

## Synchronous hooks answered locally (~1 ms)

| Hook | Answered from |
|---|---|
| `PreToolUse` policy gate | Grant and policy cache in the runner, pushed down from AgentDO. A call no rule allows is held with `defer` and escalated as a question; it runs once approved (see [runner](../runner/#lifecycle)) |
| `PermissionRequest` | Same cache |
| `Stop` | **Local inbox mirror:** queued messages come back as `decision: "block"`, at most `max_stop_continuations` per stop chain (`stop_hook_active: false` starts a new chain) |

Sync hooks are answered only for a peer process descending from the declared agent's Claude Code; others get the fail-safe fallback.

**Configuration:** hooks live in **managed settings** on the host, and repo settings never load (see [runner](../runner/)).
